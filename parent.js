import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const hash=s=>createHash('sha256').update(String(s)).digest('hex');
const send=(res,n,d)=>res.status(n).json(d);
const DAY=86400;
const SESSION_TTL=30*DAY, REQUEST_TTL=7*DAY, INVITE_TTL=180*DAY;

async function redis(cmd){
  const u=process.env.UPSTASH_REDIS_REST_URL,t=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!u||!t)throw Error('Brak konfiguracji Upstash');
  const r=await fetch(u,{method:'POST',headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'},body:JSON.stringify(cmd)});
  const j=await r.json();
  if(!r.ok||j.error)throw Error('Błąd Redis');
  return j.result;
}

// Klucz musi być identyczny jak w /api/sync.js
const syncKey=code=>'dziennik-kotow:sync:'+hash('dziennik-kotow:'+code);
const inviteKey=code=>'edukot:invite:'+hash(String(code).trim().toUpperCase());
const reqKey=id=>'edukot:request:'+hash(id);
const sessionKey=id=>'edukot:session:'+hash(id);
const INVITES_SET='edukot:invites';

const clientIp=req=>String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'?').split(',')[0].trim();

// Prosty limit prób (ochrona przed zgadywaniem PIN-u i spamem próśb)
async function hits(name,ip){return Number(await redis(['GET','edukot:rl:'+name+':'+hash(ip)]))||0}
async function addHit(name,ip,ttl){const k='edukot:rl:'+name+':'+hash(ip);const n=await redis(['INCR',k]);if(n===1)await redis(['EXPIRE',k,ttl])}

// PIN nauczyciela dla API (zmienna EDUKOT_TEACHER_PIN) – niezależny od PIN-u blokady i kodu synchronizacji.
async function teacherAuth(req,res){
  const want=process.env.EDUKOT_TEACHER_PIN;
  if(!want){send(res,503,{error:'Serwer nie ma ustawionej zmiennej EDUKOT_TEACHER_PIN (Vercel → Settings → Environment Variables).'});return false}
  const ip=clientIp(req);
  if(await hits('pin',ip)>=10){send(res,429,{error:'Zbyt wiele błędnych prób. Spróbuj za 15 minut.'});return false}
  const a=Buffer.from(hash(req.headers['x-teacher-pin']||'')),b=Buffer.from(hash(want));
  if(a.length!==b.length||!timingSafeEqual(a,b)){await addHit('pin',ip,900);send(res,401,{error:'Nieprawidłowy PIN nauczyciela'});return false}
  return true;
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-teacher-pin,x-parent-session');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    let body=req.body||{};if(typeof body==='string')body=JSON.parse(body);
    const action=body.action||req.query?.action||'';

    // 1) Rodzic wysyła prośbę o dostęp kodem
    if(req.method==='POST'&&action==='request-access'){
      const code=String(body.inviteCode||'').trim().toUpperCase(),name=String(body.parentName||'').trim().slice(0,80),contact=String(body.contact||'').trim().slice(0,120);
      if(code.length<4||name.length<2)return send(res,400,{error:'Wpisz poprawny kod i imię opiekuna'});
      const ip=clientIp(req);
      if(await hits('req',ip)>=10)return send(res,429,{error:'Zbyt wiele prób. Spróbuj ponownie za godzinę.'});
      await addHit('req',ip,3600);
      const inv=await redis(['GET',inviteKey(code)]);
      if(!inv)return send(res,404,{error:'Nie znaleziono takiego kodu'});
      const invObj=JSON.parse(inv);
      if(!invObj.active)return send(res,410,{error:'Ten kod został wyłączony'});
      const id=randomBytes(18).toString('hex');

      // Kod z autoApprove: natychmiastowa sesja, bez kolejki u nauczyciela
      if(invObj.autoApprove){
        const session=randomBytes(24).toString('hex');
        await redis(['SET',sessionKey(session),JSON.stringify({
          approved:true,
          childId:invObj.childId,
          syncKey:invObj.syncKey||syncKey(invObj.syncCode),
          parentName:name
        }),'EX',SESSION_TTL]);
        const request={id,inviteCode:code,parentName:name,contact,status:'approved',session,createdAt:Date.now(),childId:invObj.childId,childName:invObj.childName||'',autoApprove:true};
        await redis(['SET',reqKey(id),JSON.stringify(request),'EX',REQUEST_TTL]);
        return send(res,200,{ok:true,requestId:id,status:'approved',approved:true,session});
      }

      const request={id,inviteCode:code,parentName:name,contact,status:'pending',createdAt:Date.now(),childId:invObj.childId,childName:invObj.childName||''};
      await redis(['SET',reqKey(id),JSON.stringify(request),'EX',REQUEST_TTL]);
      await redis(['SADD','edukot:requests',hash(id)+':'+id]);
      return send(res,200,{ok:true,requestId:id,status:'pending'});
    }

    // 2) Rodzic sprawdza status prośby
    if(req.method==='POST'&&action==='request-status'){
      const raw=await redis(['GET',reqKey(String(body.requestId||''))]);
      if(!raw)return send(res,404,{error:'Nie znaleziono prośby'});
      const q=JSON.parse(raw);
      if(q.status==='approved')return send(res,200,{approved:true,session:q.session});
      if(q.status==='rejected')return send(res,200,{approved:false,status:'rejected'});
      return send(res,200,{approved:false,status:q.status||'pending'});
    }

    // 3) Rodzic pobiera dane WYŁĄCZNIE swojego dziecka (po akceptacji)
    if(req.method==='GET'&&req.headers['x-parent-session']){
      const raw=await redis(['GET',sessionKey(String(req.headers['x-parent-session']))]);
      if(!raw)return send(res,401,{error:'Sesja wygasła'});
      const s=JSON.parse(raw);
      if(!s.approved)return send(res,403,{error:'Brak zatwierdzonego dostępu'});
      const packed=await redis(['GET',s.syncKey||syncKey(s.syncCode)]);
      if(!packed)return send(res,404,{error:'Nie znaleziono zsynchronizowanego dziennika'});
      const d=JSON.parse(packed);
      const child=(d.kids||[]).find(k=>String(k.id)===String(s.childId));
      if(!child)return send(res,404,{error:'Przypisany uczeń nie istnieje'});
      // Obecność tylko tego ucznia – bez identyfikatorów i statusów innych dzieci
      const attendance={};
      for(const [date,day] of Object.entries(d.attendance||{})){
        if(day&&day[child.id]!==undefined)attendance[date]={[child.id]:day[child.id]};
      }
      // Zwracamy tylko bezpieczny podzbiór danych dziecka
      const safeChild={
        id:child.id,
        name:child.name||'',
        emoji:child.emoji||'🐱',
        grades:Array.isArray(child.grades)?child.grades:[],
        remarks:Array.isArray(child.remarks)?child.remarks:[]
      };
      return send(res,200,{
        approved:true,
        child:safeChild,
        attendance,
        tests:Array.isArray(d.tests)?d.tests:[],
        timetable:Array.isArray(d.timetable)?d.timetable:[],
        klass:d.klass||d.group||'EduKot 2.0',
        school:d.school||''
      });
    }

    // 4) Nauczyciel: tworzy kod dla ucznia
    if(req.method==='POST'&&action==='teacher-create-code'){
      if(!await teacherAuth(req,res))return;
      const code=String(body.code||'').trim().toUpperCase(),childId=String(body.childId||''),syncCode=String(body.syncCode||'');
      if(code.length<4||!childId||syncCode.length<4)return send(res,400,{error:'Wybierz ucznia, kod i połącz dziennik kodem synchronizacji'});
      if(!/^[A-Z0-9\-_]{4,40}$/.test(code))return send(res,400,{error:'Kod może zawierać tylko litery, cyfry, myślnik i podkreślenie (4–40 znaków)'});
      const key=syncKey(syncCode);
      const packed=await redis(['GET',key]);
      if(!packed)return send(res,400,{error:'Najpierw połącz dziennik z synchronizacją'});
      const kid=(JSON.parse(packed).kids||[]).find(k=>String(k.id)===childId);
      if(!kid)return send(res,400,{error:'Uczeń nie znajduje się w zsynchronizowanym dzienniku'});
      const existing=await redis(['GET',inviteKey(code)]);
      if(existing){
        const e=JSON.parse(existing);
        if(e.childId!==childId||e.syncKey!==key)return send(res,409,{error:'Taki kod już istnieje – wpisz inny'});
      }
      // W bazie trzymamy klucz (skrót), a nie surowy kod synchronizacji
      const autoApprove=!!(body.autoApprove===true||body.autoApprove==='true'||body.autoApprove===1||body.autoApprove==='1');
      const inv={code,childId,childName:kid.name||'',syncKey:key,active:true,autoApprove,createdAt:Date.now()};
      await redis(['SET',inviteKey(code),JSON.stringify(inv),'EX',INVITE_TTL]);
      await redis(['SADD',INVITES_SET,hash(code)+':'+code]);
      return send(res,200,{ok:true,code,childName:kid.name||'',autoApprove});
    }

    // 5) Nauczyciel: lista oczekujących próśb
    if(req.method==='GET'&&action==='teacher-requests'){
      if(!await teacherAuth(req,res))return;
      const members=await redis(['SMEMBERS','edukot:requests'])||[];
      const list=[],names={};
      for(const m of members){
        const id=m.split(':')[1];const x=id&&await redis(['GET',reqKey(id)]);
        if(!x){await redis(['SREM','edukot:requests',m]);continue}
        const q=JSON.parse(x);
        if(q.status!=='pending'){await redis(['SREM','edukot:requests',m]);continue}
        if(!(q.inviteCode in names)){
          const inv=await redis(['GET',inviteKey(q.inviteCode)]);
          names[q.inviteCode]=inv?JSON.parse(inv).childName||'':(q.childName||'');
        }
        list.push({id:q.id,inviteCode:q.inviteCode,parentName:q.parentName,contact:q.contact,createdAt:q.createdAt,childName:names[q.inviteCode]||q.childName||''});
      }
      list.sort((a,b)=>a.createdAt-b.createdAt);
      return send(res,200,{requests:list});
    }

    // 6) Nauczyciel: akceptuje lub odrzuca
    if(req.method==='POST'&&(action==='teacher-approve'||action==='teacher-reject')){
      if(!await teacherAuth(req,res))return;
      const id=String(body.requestId||'');
      const raw=await redis(['GET',reqKey(id)]);
      if(!raw)return send(res,404,{error:'Nie znaleziono prośby'});
      const q=JSON.parse(raw);
      if(q.status!=='pending')return send(res,409,{error:'Prośba została już rozpatrzona'});
      if(action==='teacher-reject'){
        q.status='rejected';
        await redis(['SET',reqKey(id),JSON.stringify(q),'EX',REQUEST_TTL]);
        await redis(['SREM','edukot:requests',hash(id)+':'+id]);
        return send(res,200,{ok:true});
      }
      const invraw=await redis(['GET',inviteKey(q.inviteCode)]);
      if(!invraw)return send(res,404,{error:'Kod zaproszenia nie istnieje'});
      const inv=JSON.parse(invraw);
      if(!inv.active)return send(res,410,{error:'Ten kod został wyłączony'});
      const session=randomBytes(24).toString('hex');
      await redis(['SET',sessionKey(session),JSON.stringify({
        approved:true,
        childId:inv.childId,
        syncKey:inv.syncKey||syncKey(inv.syncCode),
        parentName:q.parentName
      }),'EX',SESSION_TTL]);
      q.status='approved';q.session=session;
      await redis(['SET',reqKey(id),JSON.stringify(q),'EX',REQUEST_TTL]);
      await redis(['SREM','edukot:requests',hash(id)+':'+id]);
      return send(res,200,{ok:true});
    }

    // 7) Nauczyciel: lista aktywnych kodów zaproszeń
    if(req.method==='GET'&&action==='teacher-list-invites'){
      if(!await teacherAuth(req,res))return;
      const members=await redis(['SMEMBERS',INVITES_SET])||[];
      const list=[];
      for(const m of members){
        const code=m.includes(':')?m.split(':').slice(1).join(':'):m;
        const raw=await redis(['GET',inviteKey(code)]);
        if(!raw){await redis(['SREM',INVITES_SET,m]);continue}
        const inv=JSON.parse(raw);
        list.push({
          code:inv.code||code,
          childId:inv.childId,
          childName:inv.childName||'',
          active:!!inv.active,
          autoApprove:!!inv.autoApprove,
          createdAt:inv.createdAt||0
        });
      }
      list.sort((a,b)=>b.createdAt-a.createdAt);
      return send(res,200,{invites:list});
    }

    // 8) Nauczyciel: wyłącza / włącza kod
    if(req.method==='POST'&&action==='teacher-toggle-invite'){
      if(!await teacherAuth(req,res))return;
      const code=String(body.code||'').trim().toUpperCase();
      if(code.length<4)return send(res,400,{error:'Podaj kod'});
      const raw=await redis(['GET',inviteKey(code)]);
      if(!raw)return send(res,404,{error:'Nie znaleziono kodu'});
      const inv=JSON.parse(raw);
      inv.active=body.active===false||body.active==='false'?false:true;
      await redis(['SET',inviteKey(code),JSON.stringify(inv),'EX',INVITE_TTL]);
      return send(res,200,{ok:true,code,active:inv.active});
    }

    return send(res,405,{error:'Niedozwolona metoda lub akcja'});
  }catch(e){return send(res,500,{error:e.message||'Błąd serwera'})}
}
