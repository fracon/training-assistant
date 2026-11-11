"""Synthesizes the welcome tour narration with Kokoro (local, offline).

Usage: python kokoro_tts.py <kokoro-v1.0.onnx> <voices-v1.0.bin> <out dir> < jobs.json

jobs.json is a list of {"id", "text", "voice", "lang"}; one WAV is written per
job as <out dir>/<id>.wav. Called by build.mjs; see README.md.
"""
import json
import os
import sys

import espeakng_loader
import soundfile as sf
from kokoro_onnx import EspeakConfig, Kokoro


def main():
    model, voices, out_dir = sys.argv[1:4]
    jobs = json.load(sys.stdin)
    # espeak-ng expects the folder that *contains* espeak-ng-data, and silently
    # falls back to a build-time path when that folder's path is long (as in a
    # virtualenv), so point it at a short link under ~/.cache.
    data_parent = os.path.expanduser("~/.cache/kinesis-tour-espeak")
    os.makedirs(data_parent, exist_ok=True)
    link = os.path.join(data_parent, "espeak-ng-data")
    if os.path.realpath(link) != os.path.realpath(espeakng_loader.get_data_path()):
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(espeakng_loader.get_data_path(), link)
    kokoro = Kokoro(model, voices, espeak_config=EspeakConfig(
        lib_path=espeakng_loader.get_library_path(), data_path=data_parent))
    for job in jobs:
        target = os.path.join(out_dir, f"{job['id']}.wav")
        if os.path.exists(target):
            continue
        samples, rate = kokoro.create(job["text"], voice=job["voice"], speed=1.0, lang=job["lang"])
        sf.write(target, samples, rate)


if __name__ == "__main__":
    main()
