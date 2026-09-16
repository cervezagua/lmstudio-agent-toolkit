# ocr-tools

Lets a model read documents off your disk: PDFs (including scanned ones) and images. Nothing extra has to be installed.

## Do you need this?

LM Studio can already show an image to a vision model when **you** attach one to a chat. This plugin is for the rest:

- **The model opens files itself**, mid-task, without you attaching anything.
- **PDFs are not images.** A PDF can't be handed to a vision model as-is. `read_document_text` pulls out the text layer — no model involved, exact and instant — and only scanned pages go through OCR, page by page, with page ranges and a page limit.
- **Your chat model does not need vision.** OCR runs on a separate vision model chosen by key, so a text-only coding model can still read a scanned invoice.

If your chat model has vision and you just want to drop one image into the conversation, you don't need this plugin.

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `read_document_text` | `path`, `pages?` | Reads a PDF's text layer: fast, exact, no model needed. Says when a PDF looks scanned and needs OCR. |
| `ocr_document` | `path`, `pages?`, `instructions?` | Reads a scanned PDF or an image (png, jpg, webp, gif, bmp) with a vision model and returns its text. |
| `pdf_to_images` | `path`, `pages?`, `output_directory?` | Renders pages as PNG files and returns their paths, without reading them. |

`pages` takes a range like `"1-3,7"`. Have the model use `read_document_text` first on any PDF: most PDFs carry real text, which is exact and free, while OCR is a model's reading of an image.

## Choosing a vision model

Any model LM Studio marks as **Vision** works. Leave **Vision Model** empty to use whichever vision model is loaded, or set a model key to have it loaded on demand.

- General vision-language models (for example the Qwen VL family) read clean scans, screenshots and photos well.
- OCR-tuned vision models do better on dense tables, forms and handwriting. If one is available for LM Studio on your hardware, set it as the **Vision Model**.
- Reading costs one model call per page, and a page rendered at scale 2 is a lot of image tokens. Start with a couple of pages.

## Settings (per chat)

| Setting | Default | Notes |
|---|---|---|
| Root Directory | chat working dir | Documents are read only from inside this folder. |
| Vision Model | *(first loaded vision model)* | |
| PDF Render Scale | 2 | Higher reads small print better, but costs more tokens and time. |
| Max Pages Per Call | 10 | Stops a whole book from being sent to the model at once. |
| Max Output Characters | 20000 | |

## How PDFs are handled

PDF work runs in a separate Node process (`src/lib/pdf-worker.mjs`). PDF.js hands its buffers to an internal worker, which only works when the library is loaded as real ESM, while LM Studio bundles plugins as CommonJS; run in-process it fails with "Cannot transfer object of unsupported type". Rendering uses `unpdf` with `@napi-rs/canvas`, both plain npm packages, so no Poppler, Ghostscript or ImageMagick install is needed.

## Development

```bash
npm install
```

```bash
lms dev
```

Tests live in the repository root (`npm test`); they build small PDFs on the fly, so there are no binary fixtures. The `src/shared/` files are copied from the repository's `shared/` folder; edit them there.
