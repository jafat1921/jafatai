# API contract v23: strict aerab / tashkeel for Arabic-script text

Every AI feature that writes words someone will hear (lyrics, scripts, dialogue, podcast lines, dub lines, tidied transcripts) now returns Arabic-script text with its vowel marks. TTS, the song models and LTX-2.3 mispronounce bare Urdu or Arabic, so the marks are part of the text, not decoration.

No database migration. Everything below is additive.

## Languages

| Code | Language | Marks |
|---|---|---|
| `ur` | Urdu | zabar, zer, pesh, jazm, tashdeed, tanween where Urdu uses it, khari zabar, izafat zer |
| `ar` | Arabic | full tashkeel: fatha, kasra, damma, sukun, shadda, tanwin (fath, kasr, damm), superscript alef, case endings (i'rab). Hamza seats stay as written |
| `fa` | Persian | zabar, zir, pish, sukun, tashdid, ezafe kasra |
| `ps` | Pashto | zwar/zabar, zer, pesh, sukun, tashdid |
| `sd` | Sindhi | zabar, zer, pesh, sukun, shad |
| `pnb` | Punjabi (Shahmukhi) | as Urdu. `pa-Arab` and `pa-PK` are read as `pnb`; plain `pa` counts as `pnb` only when the text is in Arabic letters |

`ur-latn` (Roman Urdu) is never marked. Region suffixes are accepted (`ar-EG` is `ar`).

**No language given** (`null`, `""`, `auto`, `und`): the letters decide. Sindhi letters (ٻ ڄ ڃ ڇ ڊ ڌ ڍ ڏ ڙ ڦ ڱ ڳ ڻ ڪ ٽ) mean Sindhi, Pashto letters (ټ ډ ړ ږ ښ ګ ڼ ې ۍ ځ څ ڭ) Pashto, ݨ Shahmukhi, Urdu-only letters (ے ں ٹ ڈ ڑ ۂ ہ ھ) Urdu. Without those, پ چ ژ گ ی ک mean Persian unless common Urdu words (کی، ہے، میں…) say Urdu, and ة ى ي ك with no Persian or Urdu letters mean Arabic. Text whose letters every language shares is read as Urdu.

## Config

- `URDU_AERAB` (default `true`): the master switch. It keeps its old name so existing `.env` files carry on; `false` turns off every pass below.
- `AERAB_LANGUAGES` (default `ur,ar,fa,ps,sd,pnb`): the languages it applies to.

## The three passes

1. **First pass, in the writer's own prompt.** When the target language is Arabic-script (or, with no language, when the user's input is), the system prompt gets one rule: *"Write `<language>` in its own script WITH FULL `<aerab|tashkeel>` on every word, as described: …"* with that language's marks. With no explicit language it reads *"Wherever you write `<language>`, …"*, so a mostly English film with one Urdu character isn't forced into Urdu.
2. **Second pass, verified.** Right after the writer answers, the Arabic-script lines go through the marking pass (`aerab.finish` / `finish_sync`). The LLM only proposes marks; they are moved onto the writer's own letters, and a line whose letters changed is kept exactly as written. If the LLM is down, the writer's text is kept and the request still succeeds (logged, never an error).
3. **Render time.** Just before a song, a speech take, a dialogue or podcast line, a dub line or a video renders, lines that are still unmarked get marked (`*_written` keeps the original, as before).

**Strict retry.** After the marking pass, any line whose coverage is below the threshold is sent once more in a small batch with a stricter instruction. Coverage is the share of Arabic-script words carrying at least one mark, not counting one-letter words and short function words (و، کی، ہے، في، من، از، که…). The threshold is 0.7 for Arabic (fully vocalised) and 0.5 for the others (long vowels written with alif / wao / ye stay bare). A failed retry keeps the first pass's result.

**Stats** wherever a pass reports back: `marked` (lines that gained marks), `kept` (lines left as written because the marking changed their letters), `low_coverage` (lines still below the threshold after the retry).

**Letter check, per language.** Look-alike code points are folded only for the comparison: Urdu and Shahmukhi fold Arabic ي ى ك ه ة onto ی ک ہ ۃ; Persian folds onto ی ک ه; Pashto never folds ي into ی (two letters in Pashto); Sindhi folds onto ي and ڪ; Arabic folds Persian ی ک ہ onto ي ك ه and tolerates an added or dropped hamza seat on alif, but never folds ى into ي. The writer's own code points are what end up in the text, so Arabic keeps Arabic letters.

## Where it runs

| Feature | First pass | Second pass | Render time |
|---|---|---|---|
| Lyrics writer (`POST /audio/lyrics`, `aerab: true`) | yes, by `language` | yes | song render |
| Film scripts: AI Director outline drafts, Write missing, Continue story, AI Assist (draft from idea, expand, tighten, rewrite tone, write dialogue) | yes, language read from the brief, idea and nearby scenes | yes, on `script_text` | quoted dialogue in shot videos |
| Quick film (autopilot) scene drafts | yes | yes | quoted dialogue in the take |
| Podcast writer: episode, chapters, line edits | yes, by episode language | yes, per line | line takes |
| Podcast show notes | yes | yes | n/a |
| Dub translation, careful review, shorter line | yes, by target language | yes | unmarked target lines (typed in the editor) before TTS |
| Transcript tidy-up | yes, by transcript language (or letters) | yes, on `clean` | n/a |
| Speak, Dialogue lines, Voice Gallery samples | n/a (user text) | n/a | yes, any Arabic-script `language` |
| Video prompts and long-take beats | no (see below) | no | quoted spoken lines, any Arabic-script language |

**Not marked, on purpose:**
- **Text drawn inside images or frames.** Image prompts (and magic prompts for images) keep quoted sign, poster and title text exactly as typed: image models draw diacritics badly and they break the lettering. The worker never marks image kinds.
- **Video prompts at writing time.** Magic prompts and storyboard frame / motion prompts aren't given the rule; their quoted spoken lines are marked at render time instead, which covers user-typed prompts too.
- **Loglines, summaries, character looks, location notes, brand copy.** Not spoken. Brand taglines are typed by the user and drawn into frames, so they stay as typed.

## Endpoints

### `POST /api/text/aerab` (new)
The one "Add aerab" every editor calls.
- Body: `{text (1..60000), language?}`. Several lines are marked line by line; lines like `[chorus]` and Latin text are left alone.
- 200: `{text, marked, kept, low_coverage, language}` where `language` is the one used (given or detected).
- 422 when there are no Arabic-script lines; 503 when the LLM is offline.

### `POST /api/audio/lyrics/aerab` (kept)
Now `{lyrics, language?}` → `{lyrics, marked, kept, low_coverage, language}`. See v14.

### `POST /api/audio/lyrics`
Response adds `low_coverage`.

### `PUT /api/transcripts/{id}/clean` (new)
`{lines: string[]}`, one entry per segment, replaces the tidied text (`segments[].clean`, `cleanup_text`). The transcript page saves "Add aerab" on the tidied text through it. 409 while a tidy-up is running, 422 when the count doesn't match. Returns the transcript.

## Frontend

- `components/text/AerabButton.tsx` + `hooks/useAerab.ts`: "Add aerab" with one-step undo (undo is offered while the text is still what the marking produced), the result line shown under the buttons and announced through the app's live region (`lib/aerab.ts` `aerabNote`). The button only appears when the text has Arabic-script letters.
- Used in: Speak script, Lyrics editor (language-aware, Arabic included), Dialogue (per line, and "Add aerab to all lines" in the toolbar), Podcast script (per line and all lines), Dub line editor (target text), Transcribe (tidied text), and the film Scene editor (script).
- `AerabOnNote` ("Aerab: on" / "Tashkeel: on") in the Podcast source step, the New dub form and the scene's "Let AI draft" form when the language (or the idea) is Arabic-script. The lyrics writer keeps its "With aerab" / "With tashkeel" checkbox, now for every Arabic-script language.
- Song and speech payloads send `aerab` for every Arabic-script language, not just `ur`.
