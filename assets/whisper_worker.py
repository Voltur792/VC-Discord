"""Reuse an existing Astra GGML model. PCM and results stay in memory."""
import base64
import contextlib
import json
import os
import sys
from pathlib import Path


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        import numpy as np
        from pywhispercpp.model import Model
    except Exception:
        send({"error": "package_missing"})
        return 1
    path = Path(sys.argv[1])
    if not path.is_file():
        send({"error": "model_missing"})
        return 1
    try:
        # Native fopen on Windows may not accept Cyrillic absolute paths.
        os.chdir(path.parent)
        # The package otherwise expands the relative filename back to an
        # absolute Unicode path. This worker permits only the checked local
        # model, and never permits the package's automatic model downloader.
        from pywhispercpp import utils
        utils.resolve_model_path = lambda *_args, **_kwargs: path.name
        with contextlib.redirect_stdout(sys.stderr):
            model = Model(path.name, context_params={"use_gpu": False},
                          n_threads=min(8, max(1, (os.cpu_count() or 4) // 2)),
                          no_context=True, no_timestamps=True,
                          print_progress=False, print_realtime=False,
                          print_timestamps=False,
                          redirect_whispercpp_logs_to=sys.stderr)
        if model._ctx is None:
            raise RuntimeError("Whisper context unavailable")
        send({"ready": True})
    except Exception:
        send({"error": "model_load_failed"})
        return 1
    while True:
        line = sys.stdin.readline(1_500_001)
        if not line:
            break
        if len(line) > 1_500_000 or not line.endswith("\n"):
            return 1
        request = {}
        try:
            request = json.loads(line)
            pcm = base64.b64decode(request["audio"], validate=True)
            if not pcm or len(pcm) > 960_000 or len(pcm) % 2:
                raise ValueError("Invalid audio")
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            language = request.get("language", "ru")
            if language != "auto" and (not language.isalpha() or len(language) > 3):
                raise ValueError("Invalid language")
            with contextlib.redirect_stdout(sys.stderr):
                segments = model.transcribe(audio, language=language,
                                            no_context=True)
            send({"id": request["id"], "text": " ".join(s.text.strip() for s in segments).strip()[:8192]})
        except Exception:
            send({"id": request.get("id"), "error": "transcribe_failed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
