# EduKot 2.0 – Panel rodzica

Panel rodzica korzysta ze wspólnego API wdrożonego razem z panelem nauczyciela.

## Konfiguracja
1. Wdróż panel **nauczyciela** jako projekt Vercel i przypisz mu domenę (np. `edukot-nauczyciel.vercel.app`).
2. W obu projektach ustaw te same `UPSTASH_REDIS_REST_URL` i `UPSTASH_REDIS_REST_TOKEN`.
3. W panelu nauczyciela ustaw `EDUKOT_TEACHER_PIN` (wymagane – bez niej API odmawia tworzenia kodów i akceptacji próśb).
4. Jeśli domena API nauczyciela jest inna niż domyślna, w przeglądarze panelu rodzica ustaw w localStorage:
   ```js
   localStorage.setItem('edukot-api-base', 'https://twoja-domena-nauczyciela.vercel.app')
   ```
5. Nauczyciel łączy dziennik kodem synchronizacji, tworzy kod dla wybranego kotka i przekazuje go rodzicowi.
6. Rodzic wpisuje kod → wysyła prośbę → nauczyciel akceptuje w **Kody rodziców**.
7. Po akceptacji rodzic automatycznie widzi dziennik **tylko swojego dziecka**.

## Co widzi rodzic
- Oceny dziecka
- Obecność (tylko wpisy tego ucznia)
- Uwagi i pochwały
- Sprawdziany / kartkówki (klasowe)
- Plan lekcji
- Średnią ocen i % obecności

## Bezpieczeństwo
- Sesja rodzica to losowy token (TTL 30 dni), przechowywany lokalnie.
- API zwraca wyłącznie dane przypisanego dziecka – bez listy innych uczniów.
- Limit prób (rate limit) chroni przed zgadywaniem kodów i spamem.
- Kod synchronizacji nauczyciela **nie** jest udostępniany rodzicowi.

To lekki projekt hobbystyczny. Zmień domyślne PIN-y przed użyciem danych prywatnych.
