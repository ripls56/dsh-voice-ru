# dsh-voice-ru

Русское распознавание речи для голосового ввода **DeepSeek Harness** (DSH).

Плагин добавляет в голосовой ввод второй локальный провайдер рядом со встроенным
SenseVoice, который русский не понимает. Движок — NVIDIA Nemotron 3.5 ASR
Streaming 0.6B (GGUF) на нативном рантайме transcribe.cpp. Всё считается локально,
интернет нужен только для первой загрузки файлов.

*English: local speech-to-text provider for DSH voice input, adding Russian (and 28
more locales) via NVIDIA Nemotron 3.5 ASR on transcribe.cpp. Model and native
runtime download on first use; no binaries are stored in this repository.*

## Требования

- DSH (десктоп) с включённым голосовым вводом; подойдёт Windows x64, Linux x64/arm64, macOS arm64/x64.
- ~1 ГБ свободного диска (модель 751 МБ + рантайм 2–21 МБ + кэш).
- Интернет при первом запуске: скачиваются рантайм (с GitHub) и модель (с Hugging Face).

## Установка

### Вариант 1. Из GitHub через менеджер плагинов DSH

1. Settings → Plugins → установка бандла.
2. Укажите спецификацию: `github:ripls56/dsh-voice-ru`
3. Подтвердите установку и перезапустите DSH.
4. Settings → Voice input → провайдер **Nemotron 3.5 ASR 0.6B (Q8_0 GGUF)**, язык **Авто**.

Если менеджер спросит про install-скрипт пакета `koffi` — можно отказать:
koffi несёт готовые бинарники в самом пакете, скрипт лишь оптимизация.

### Вариант 2. Вручную (локальная копия)

```bash
git clone https://github.com/ripls56/dsh-voice-ru
cd dsh-voice-ru
npm install            # или: npm install --omit=dev
```

Затем добавьте плагин в профиль DSH (`%USERPROFILE%\.dsh\profiles\<профиль>\package.json`
или `~/.dsh/profiles/<профиль>/package.json`):

```json
{
  "dependencies": { "dsh-voice-ru": "link:C:/path/to/dsh-voice-ru" },
  "dsh": { "profile": { "bundles": ["...", "dsh-voice-ru"] } }
}
```

и перезапустите DSH. Строку `- id: voice-ru` добавлять не нужно: плагин несёт свой
`cordis.patch.yml` и сам вставляет себя в композицию.

## Первый запуск

При первом `prepare()` (кнопка подготовки в Settings → Voice input или первая запись)
плагин сам скачивает и проверяет по sha256:

| Что | Откуда | Размер |
| --- | --- | --- |
| Рантайм transcribe.cpp v0.3.1 под вашу платформу | GitHub release | 1.8–21 МБ |
| Модель `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf` | Hugging Face | 751 МБ |

Кэш: `%LOCALAPPDATA%\dsh-voice-ru` (Windows) или `~/.local/share/dsh-voice-ru`.
Частично скачанный файл публикуется только после проверки хеша, поэтому обрыв
сети не портит кэш. Прогресс виден в Settings → Voice input.

## Язык: русский, английский и смешанная речь

В списке языков есть `Авто` и русский:

- **Авто** — модель сама определяет язык. Русская речь распознаётся как обычно,
  а английские слова внутри неё сохраняются латиницей.
- **ru** — жёсткая подсказка русского. Чистый русский чуть стабильнее, но английские
  слова могут уехать в кириллицу.

Замеры на синтезированной речи (`npm run test:lang`, файлы `test/*sample.wav`):

| Произнесено | `ru` | `auto` |
| --- | --- | --- |
| «Запушь изменения в **main branch** и открой **pull request**» | Запуш изменения и открой **пул рек**. Потом запусти тесты | Запуш изменения **main branch** и открой **Pull Request** Потом запусти тесты |
| «Открой файл **config.json** и сделай **git push** в ветку **main**» | Открой файл **конфигсон** и сделай **гит Пуш** ветку **main** | Открой файл, **конфигсон** и сделай **git push** в ветку **main** |
| чистый русский, 8.6 с | корректно, с пунктуацией | тот же корректный текст |

Поэтому по умолчанию ставится `Авто`. Слитно произнесённые составные термины
вроде «config.json» авторежим иногда всё ещё отдаёт кириллицей: у модели нет
`VOCABULARY` / `CONTEXT_PROMPT` (проверяется `npm run test:features`), подсказать
ей список терминов нельзя.

## Как это работает

```
клиент voice-input (WAV 16 кГц моно PCM16)
        │  speech/transcribe
        ▼
speechToText (DSH)  ──►  провайдер nemotron-local (этот плагин)
                              │  subprocess + bearer-токен
                              ▼
                     lib/worker.js: koffi → transcribe_run → текст
```

- `lib/index.js` — регистрация провайдера, состояния подготовки, скачивание
  рантайма и модели с проверкой sha256, очередь запросов, выгрузка воркера после
  5 минут простоя.
- `lib/runtime.js` — таблица платформенных рантаймов (URL + sha256), распаковка
  `.tar.gz` без внешних зависимостей, поиск библиотеки.
- `lib/download.js` — атомарная загрузка с проверкой размера и хеша.
- `lib/worker.js` — процесс-воркер: FFI через koffi, HTTP `/transcribe?language=…`.
- `lib/locales.js` — короткие коды (`ru`) → локали модели (`ru-RU`).

Скорость на RTX 3060 (Vulkan): ~0.5 с на 8.6 с аудио (RTF x15–18); на CPU ~1.3 с
(RTF x6). Модель держится в памяти между записями.

## Тесты

```bash
npm install            # нужен koffi
npm run test           # провайдер целиком на mock-контексте DSH
npm run test:fresh     # «чистая установка»: пустой кэш, скачивание рантайма, транскрипция
npm run test:ffi       # сырой FFI: koffi → библиотека → модель
npm run test:lang      # сравнение языковых подсказок на смешанной речи
npm run test:features  # какие фичи модели поддержаны
```

`test:fresh` проверяет ровно тот путь, который проходит новый пользователь
(модель берётся из кэша, рантайм скачивается по-настоящему; `--download-model`
заставляет скачать и модель).

## Конфигурация (необязательно)

Ключи в записи плагина:

| Ключ | По умолчанию | Назначение |
| --- | --- | --- |
| `providerId` | `nemotron-local` | id провайдера в DSH |
| `dataRoot` | `%LOCALAPPDATA%\dsh-voice-ru` | кэш рантайма и модели |
| `runtimeDir` | — | готовый каталог transcribe.cpp вместо загрузки |
| `modelPath` | — | готовый файл модели вместо загрузки |
| `backend` | `auto` | `auto`/`cpu`/`vulkan`/`cuda`/`cpu_accel` |
| `threads` | `0` | потоки CPU (0 — выбор библиотеки) |
| `idleTimeoutMs` | `300000` | простой до выгрузки воркера |
| `inferenceTimeoutMs` | `120000` | таймаут одной транскрипции |

## Ограничения

- Максимальная длительность записи — лимит voice-input DSH (120 с).
- Первый запуск требует сети; дальше всё офлайн.
- Модель распространяется по лицензии OpenMDW-1.1, рантайм и ggml — MIT.

## Лицензии и источники

- Код плагина: MIT (см. [LICENSE](LICENSE)).
- [nvidia/nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
  — модель, лицензия OpenMDW-1.1.
- [handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf](https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf)
  — GGUF-конвертация, к которой привязан плагин (sha256 закреплён в коде).
- [handy-computer/transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) v0.3.1
  — нативный рантайм, MIT.