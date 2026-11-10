# Welcome tour video build

The dashboard welcome tour is a narrated motion graphic with sound effects and
captions, produced once per language (`pt`, `en`) by `build.mjs`. The outputs are
committed under `src/public/assets/onboarding/tour/` together with the generated
manifest `src/public/shared/onboarding-tour-media.js`. The application never runs
this build; it only serves the files.

## Sources of truth

| What | Where |
| --- | --- |
| Scene order and narration cue keys | `TOUR_SCENES` in `src/public/shared/onboarding.js` |
| Narration and caption text (also the dialog transcript) | `home.onboarding.tour.cues.*` in `src/public/locales/{pt,en}.json` |
| On-screen labels inside the video | `strings.mjs` (mirrors `shell.nav.*` names) |
| Scene timing and sound-effect beats | `timeline.mjs` |
| Animation | `scene.html` + `scene.js` (tokens copied from `shared/theme.css`) |
| Sound effects and music bed | `audio.mjs` (synthesized, no third-party samples) |

Scene length follows the measured narration, so changing a sentence in a locale
file and rebuilding keeps voice, captions, animation and effects aligned.

## Requirements (build machine only)

- Node 24+, Google Chrome at `/usr/bin/google-chrome`, network access to Google
  Fonts for DM Sans while rendering frames.
- `ffmpeg` with `libvpx-vp9`, `libopus`, `libopenh264` and `aac`.
- [Piper](https://github.com/rhasspy/piper) neural TTS and two voices from
  `rhasspy/piper-voices` v1.0.0: `pt_BR-faber-medium` and `en_US-ryan-high`
  (`.onnx` + `.onnx.json`). Speech is synthesized locally; no text is sent to a
  cloud service.

```sh
python3 -m venv /tmp/piper && /tmp/piper/bin/pip install piper-tts
B=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0
for v in pt/pt_BR/faber/medium/pt_BR-faber-medium en/en_US/ryan/high/en_US-ryan-high; do
  curl -sLO "$B/$v.onnx"; curl -sLO "$B/$v.onnx.json"
done
```

## Build

```sh
# Quick visual check: three frames per scene in <work>/preview-<lang>/
node scripts/onboarding-tour/build.mjs --piper /tmp/piper/bin/piper --voices . --work /tmp/tour --preview

# Full build (both languages, ~10 minutes)
node scripts/onboarding-tour/build.mjs --piper /tmp/piper/bin/piper --voices . --work /tmp/tour
```

`--lang pt` or `--lang en` rebuilds one language; the other's manifest entry is
kept from the work directory. Each language produces `kinesis-tour-<lang>.webm`
(VP9/Opus), `.mp4` (H.264/AAC fallback), `.vtt` captions and `-poster.jpg`.
Asset URLs in the manifest carry a content hash, so browsers never mix an old
video with new captions.

Spoken respellings (for example `Kinesis` → `Kinésis` for the Portuguese voice)
live in `RESPELL` in `build.mjs`; captions and the transcript keep the written form.
