# Welcome tour video build

The dashboard welcome tour is a narrated motion graphic produced once per
language (`pt`, `en`) by `build.mjs`. The outputs are committed under
`src/public/assets/onboarding/tour/` together with the generated manifest
`src/public/shared/onboarding-tour-media.js`. The application never runs this
build; it only serves the files.

## How it is made

1. **Narration** — [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a
   local neural TTS, speaks each cue (`kokoro_tts.py`): voice `pm_santa` for
   Portuguese and `am_michael` for English.
2. **Word timings** — [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
   transcribes every cue clip, so each camera move and highlight lands on the
   word that names it. The build prints what whisper heard for each cue; read it
   to catch a mispronunciation.
3. **Screens** — `capture.mjs` starts a throwaway in-memory Kinesis server with
   one synthetic athlete (no real data), photographs the real pages in headless
   Chrome at 1440×810 scaled to 1920×1080, and measures the boxes of the
   controls the video zooms into.
4. **Composition** — `compose.mjs` writes a [HyperFrames](https://hyperframes.heygen.com)
   project (one sub-composition per scene), which HyperFrames checks and renders
   at 1920×1080, 30 fps.
5. **Delivery** — ffmpeg encodes 1280×720 VP9/Opus WebM and H.264/AAC MP4, a
   poster, and the WebVTT captions; the manifest URLs carry content hashes.

The video follows the HyperFrames motion and sound guidance: one idea per
screen with one short headline, real screens with zooms into the part that
matters, a cursor that clicks the control the narrator names, moves anchored to
spoken words, and text inside the title-safe area. The narration never says
"AI"; it talks about the planning itself. The watch scene is a generic watch,
deliberately without a brand, because more watch makers are planned.

Sound: every effect has a visible cause and peaks one frame after its picture —
a soft whoosh on each cut (three takes in rotation), a pop when a control is
highlighted, a click when the cursor presses, a soft click and pop when a
workout is dragged, a notification when it reaches the watch, and one riser into
the closing chime. A music bed sits about 18 dB under the voice and ducks further
while the narrator speaks. The final mix is normalized to -16 LUFS with a
-1.5 dBTP ceiling; check it with `npx hyperframes@0.9.31 audio <video> --json`.

## Sources of truth

| What | Where |
| --- | --- |
| Scene order and narration cue keys | `TOUR_SCENES` in `src/public/shared/onboarding.js` |
| Narration and caption text (also the dialog transcript) | `home.onboarding.tour.cues.*` in `src/public/locales/{pt,en}.json` |
| Spoken respellings (e.g. `Kinesis` → `Kinésis`, `FIT` → `fít` in PT) | `RESPELL` in `build.mjs` |
| On-screen headlines and labels | `strings.mjs` |
| Scene timing | `timeline.mjs` (follows the measured narration) |
| Screens and zoom targets | `SHOTS` in `capture.mjs` |
| Scenes, camera moves, highlights | `compose.mjs` (word anchors per scene; English equivalents in `EN_WORDS`) |
| Effects, levels and mix | `audio.mjs` (effects), `finalMix` in `build.mjs` (music bed, ducking, loudness) |

Changing a sentence in a locale file and rebuilding keeps voice, captions,
moves and effects aligned. If a cue no longer contains an anchor word, the move
falls back to the word's position in the text; update the anchor in
`compose.mjs`.

## Requirements (build machine only)

- Node 24+, Google Chrome at `/usr/bin/google-chrome`, ffmpeg with
  `libvpx-vp9`, `libopus`, `libopenh264` and `aac`, and network access to Google
  Fonts, the GSAP/Lucide CDNs and npm (`npx hyperframes@0.9.31`).
- Kokoro in a Python virtualenv plus its two model files:

  ```sh
  python3 -m venv ~/.venvs/kokoro && ~/.venvs/kokoro/bin/pip install kokoro-onnx soundfile
  mkdir -p ~/kokoro && cd ~/kokoro
  B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
  curl -sSLO $B/kokoro-v1.0.onnx && curl -sSLO $B/voices-v1.0.bin
  ```

- `whisper-cli` on the `PATH` and a multilingual model (Fedora ships only the
  library, so build it):

  ```sh
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/.local/src/whisper.cpp
  cd ~/.local/src/whisper.cpp
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF && cmake --build build -j
  install -m 755 build/bin/whisper-cli ~/.local/bin/ && sh ./models/download-ggml-model.sh small
  ```

- Sound effects: the Pixabay-licensed library bundled with the HyperFrames
  media skill (`npx hyperframes@0.9.31 skills`), read from
  `~/.claude/skills/media-use/audio/assets/sfx` (override with `--sfx <dir>`).
  The Pixabay Content License allows commercial use without attribution; the
  raw files are not committed, only the mixed result.
- Music bed (optional, `--music <file>`): the current videos use the HeyGen
  catalog track "Astral Generated Music: 05ca2a0c" ("light upbeat professional
  corporate background, warm and optimistic"), retrieved with a free HeyGen
  sign-in (`npx hyperframes@0.9.31 auth login`) under HeyGen's terms. Keep the
  file outside the repository and pass its path; `--music-start <s>` skips into
  the track. Without `--music` the video has voice and effects only.

Speech is synthesized and transcribed locally; no narration text is sent to a
cloud service. Set `HYPERFRAMES_NO_TELEMETRY=1` (the build does) to keep the
HyperFrames CLI from sending usage events.

## Build

```sh
ARGS="--music $HOME/kokoro/tour-music.mp3 --python $HOME/.venvs/kokoro/bin/python --kokoro $HOME/kokoro --whisper-model $HOME/.local/src/whisper.cpp/models/ggml-small.bin --work /tmp/tour"

# Review: narration, screens and the HyperFrames project, checked but not rendered.
node scripts/onboarding-tour/build.mjs $ARGS --preview
# Then, inside /tmp/tour/<lang>/video: npx hyperframes@0.9.31 snapshot --review
# (or `preview` to open it in the browser).

# Full build (both languages, a few minutes).
node scripts/onboarding-tour/build.mjs $ARGS
```

`--lang pt` or `--lang en` rebuilds one language; the other's manifest entry is
kept from the work directory.
