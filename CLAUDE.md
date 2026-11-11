# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VisionLabel is a browser-based image labeling tool for YOLO (detect / pose / segment) and image classification (MobileNet / ResNet). It has a FastAPI backend built on [fastapi-modular](https://pypi.org/project/fastapi-modular/) with SQLite, and a plain ES-module SPA in `web/` that needs no build step. README.md is the user-facing spec, in Vietnamese. Read it before changing behaviour. Code comments, docstrings, UI strings and the README are all in Vietnamese; keep new ones in Vietnamese too.

## Commands

```bash
. .venv/bin/activate          # or create it: python -m venv .venv && pip install -r requirements.txt
cp .env.example .env          # first time only
fam dev                       # runs src/main.py, http://localhost:8000 (API docs at /docs)
fam install <component>       # adds a fastapi-modular extra; it also edits requirements.txt and .env
```

There is no test suite, linter config or build step. Check changes by running the app. `APP_DB__SCHEMA_MODE=sync` (the default in `.env.example`) adds new entity columns at startup. Dropping columns needs `APP_DB__DROP_COLUMNS=true`. Production should use `off` plus `fam migrate`.

## Backend architecture (fastapi-modular)

- `src/main.py` assembles the app by hand. `register_routes` scans `src/api/`, so a new module needs no edit to `main.py`. The SPA is mounted at `/` last, so `/api/...` routes match first.
- Each folder under `src/api/<module>/` is a module with the same layout: `*_controller.py` (`@controller(prefix=..., guards=[Authenticated])`, route decorators from `fastapi_modular.core.controller`), `*_service.py` (`@injectable`, with `Repository[Entity]` and other services injected through `__init__`), `entities/` (`@entity` dataclasses), and `dto/`. Business errors are fastapi-modular's `NotFoundError` / `ConflictError` / `ForbiddenError`.
- Auth: `src/api/auth/guards.py`. `Authenticated` reads the session cookie. `AdminOnly` is added per route. `caller()` returns the current user; services take a `Caller` and scope their queries (labelers only ever see images assigned to them, and the server returns 403 for everything else, raw image files included).
- Config: `src/core/config.py` (`AppSettings`, nested groups map to env vars as `APP_<GROUP>__<FIELD>`). New env vars go both there and in `.env.example`. File paths on disk go through `src/core/storage.py` only.
- Startup and shutdown work lives in `src/core/lifespan.py`: backfilling image columns, marking interrupted Drive uploads, resuming the watch on GPU jobs, and closing SSH on shutdown.

### Core domain rules (they span modules)

- **Image lifecycle** (`images/entities/image_model.py`): `unlabeled → in_review → labeled`, and `rejected` sends an image back to its labeler. Every save, including an admin's, goes to `in_review`. Only an explicit approve sets `labeled`, and only `labeled` images go into datasets. Assignment claims each image with compare-and-set on `assigned_to = ''`. `images/locks.py` holds an image for 5 minutes, renewed while it stays open, so two people never edit the same image at once.
- **Classes** (`projects/classes.py`) are a JSON list on `Project.classes`. Labels reference a class by its **stable id**, never by position. A class that has labels cannot be deleted and cannot change its draw kind (box / pose / polygon) or point count. The rules live in `classes.py`.
- **Annotations** are stored in the DB normalized to 0..1 (`images/annotations.py`). They are converted to YOLO/ImageFolder only when a dataset version is exported (`datasets/exporter.py`), so exported versions in `dataset/<project>/v<n>/` are immutable snapshots. The exporter also builds the per-class "export as-is / convert / cannot export" plan. Every zip includes `visionlabel.json` (full class config plus original labels), which the importer uses to restore a project losslessly on another machine.
- **Realtime** (`live/`): `LiveEvents.project(...)` sends to admins watching a project (`project.changed`). `LiveEvents.user(...)` goes only to the labeler concerned (`me.changed`). A failed emit must never break the main operation: catch the error and log it. Services call these after state changes, and the frontend (`web/js/live.js`) refreshes counts and grids from them.
- **GPU** (`gpu/`): remote Ubuntu GPU servers reached only over SSH (paramiko, `ssh.py`). `agent.py` is uploaded to the server and run there: a JSON-lines stdin/stdout loop that keeps the model in VRAM. It also sits inside `src/api/` and gets scanned, so it must import without torch or ultralytics; heavy imports stay inside functions. Install and train jobs are bash scripts from `scripts.py`, run with `nohup setsid` in `<workdir>/jobs/<id>/` (`pid`, `log.txt`, `exit_code`), so they survive an app restart and `GpuService.resume()` picks them up again. `autolabel.py` maps model output onto project classes.
- **Drive** (`drive/`): Google Drive REST calls over urllib with the `drive.file` scope only. OAuth client credentials and refresh tokens, like SSH passwords and keys, are stored in `data/app.db`.

## Frontend

- `web/js/app.js` is a hash router: `#/p/<pid>/<section>`, and `#/p/<pid>/label/<imageId>?queue=` opens the labeler. Each page module in `web/js/pages/` is registered there with an optional role (`admin` / `labeler`). `web/js/api.js` wraps REST calls and `web/js/ui.js` holds shared helpers (`h`, `esc`, `toast`, `ICONS`...).
- `web/js/editor/` is the canvas labeler: `editor.js` (zoom, pan, magnifier, undo), `object-tool.js` (box / pose / polygon), `classify-tool.js`.
- Static files are served with `Cache-Control: no-cache` (the `WebFiles` class in `main.py`), so a browser reload picks up JS changes without restarting the server.
- For UI design work, the repo ships a `frontend-design` skill in `.claude/skills/`.

## Runtime data (gitignored)

`data/app.db` (SQLite plus secrets, and `data/secret.key` when `APP_AUTH__SECRET` is empty), `storage/projects/<id>/{images,thumbs}/`, `storage/models/`, `dataset/<project-slug>/v<n>/`.
