# Cutline

A subtitle editor built with plain HTML, CSS, and JavaScript. Open local media, edit SRT subtitles, check timing and readability, and export your work. The interface follows the approved deep-clean design.

**[Open Cutline](https://anikthink.github.io/cutline-subtitle-editor/)** · **[Download the standalone HTML](https://github.com/anikthink/cutline-subtitle-editor/releases/latest/download/Cutline.html)**

## Use it

1. Open the web app, or download `Cutline.html` and double-click it to open it in your browser. The downloaded file contains the entire app and works without a server or internet connection.
2. Choose **Open subtitles** for an SRT file, or **Add cue** to start from scratch. Choose **Open media** for local audio or video.
3. Edit text and timings in the inspector. Select multiple cues to shift their timing together. Use review markers and the Issues filter to work through a project.
4. Choose **Export SRT** to download subtitles. Use **Project → Save project backup** (or Ctrl/Cmd+S) to keep the full project, including review markers and reference text.

Subtitle edits save in this browser as you type. **Project → New / recent projects** opens earlier projects. Browser storage belongs to the current browser profile and site; it is separate from your original SRT file. Keep project backups, especially before clearing browser data or changing devices. Private browsing and browser settings can limit storage. Storage for a downloaded `file:` page can vary by browser and file location.

Media files stay on your device and are not included in backups. After reopening a project, select the media file again. Moving between the hosted app and the downloaded HTML requires a project backup.

## Included in this version

- UTF-8 SRT import/export, including multiline and non-Latin dialogue.
- Explicit import reports for malformed subtitle blocks, with a choice to cancel or import valid cues.
- Millisecond timing edits, waveform handles, group shifts, and overlap checks.
- Local audio/video playback, subtitle overlay, seeking, playback speed, and cue replay.
- Text editing, punctuation cleanup, add/delete, undo/redo, review markers, search, and filters.
- Reference SRT text attached to each cue, so references survive insertion and deletion.
- IndexedDB project storage, immediate recovery journals, and JSON project backups.
- A virtualized cue list checked with 10,000 subtitles.
- No framework, runtime dependencies, CDN assets, account, or upload service.

## Limits

This is an initial browser release. It supports SRT, not ASS/SSA or VTT. Reference subtitles match the current row order; they are not automatically aligned by meaning or time. Quality checks are editing aids, not broadcaster-specific compliance rules.

Media support depends on the codecs available in your browser. Waveform decoding is skipped for files over 96 MiB or when estimated decoded stereo audio would exceed 256 MiB (roughly 12 minutes at 48 kHz). Playback and timing controls remain available. Some video codecs can play without supporting waveform decoding.

The standalone HTML runs in a desktop browser; it is not a native Windows/macOS/Linux installer. A desktop wrapper and bounded waveform extraction for long media are later steps. No React migration is needed to add a wrapper.

## Development

Use Node.js 20 or newer. There are no packages to install.

```sh
npm test
npm run build
npm start
```

Open `http://127.0.0.1:8765`. On Windows, if `node` is shadowed by another command, use `node.exe` with the corresponding scripts.

The build writes:

- `dist/` — the static website for GitHub Pages.
- `downloads/Cutline.html` — the self-contained offline app, also copied into the website.

The production source is `index.html`, `assets/styles.css`, and the modules in `src/`. `scripts/build.mjs` combines the same source into the standalone HTML. Both versions share the same editing and storage code.

## Checks and deployment

`npm test` runs the core tests for timestamps, Unicode SRT round trips, invalid imports, overlaps, shifts, backups, history, and 10,000-cue parsing.

With the server running, open `/tests/browser.html` in a disposable browser profile. It creates test projects and checks focused-text recovery after immediate reload, review undo/redo, timing validation, exports, backups, delete-all recovery, partial imports, 10,000-row virtualization, concurrent-save protection, and the standalone build. Run the build first. Media playback, waveform generation, and responsive layouts are also checked interactively before release.

The Pages workflow tests and builds every push to `main`, then deploys `dist/`. It also checks pull requests without deploying them. Downloadable release assets come from the same build.
