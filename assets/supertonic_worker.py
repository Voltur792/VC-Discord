"""Synthesize from existing Astra model files; never capture or play PC audio."""
import base64
import contextlib
import json
import sys
from pathlib import Path

def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def main():
    try:
        import numpy as np
        from supertonic import TTS
        model_dir = Path(sys.argv[1])
        with contextlib.redirect_stdout(sys.stderr):
            engine = TTS(model="supertonic-3", model_dir=model_dir, auto_download=False,
                         intra_op_num_threads=4, inter_op_num_threads=1)
        send({"ready": True})
    except Exception:
        send({"error": "Supertonic не загрузился. Проверьте Python, пакет supertonic и файлы модели Astra."})
        return 1
    styles = {}
    for line in sys.stdin:
        if len(line) > 20000:
            return 1
        value = {}
        try:
            value = json.loads(line)
            voice = value.get("voice", "F4")
            if voice not in {f"{kind}{i}" for kind in "MF" for i in range(1, 6)} | {"custom"}:
                raise ValueError("Unknown voice")
            key = str(value.get("voice_path", "")) if voice == "custom" else voice
            if key not in styles:
                if voice == "custom":
                    path = Path(key)
                    if path.suffix.lower() != ".json" or path.stat().st_size > 1_500_000:
                        raise ValueError("Invalid voice profile")
                    styles[key] = engine.get_voice_style_from_path(path)
                else:
                    styles[key] = engine.get_voice_style(voice_name=voice)
            with contextlib.redirect_stdout(sys.stderr):
                audio, _ = engine.synthesize(text=str(value.get("text", ""))[:1000],
                    voice_style=styles[key], lang="ru", speed=max(.7, min(2., float(value.get("speed", 1.1)))),
                    total_steps=5, max_chunk_length=180, verbose=False)
            pcm = (np.clip(audio.reshape(-1), -1, 1) * 32767).astype("<i2").tobytes()
            if len(pcm) > 8_000_000:
                raise ValueError("Too much audio")
            send({"id": value["id"], "audio": base64.b64encode(pcm).decode("ascii"), "rate": engine.sample_rate})
        except Exception:
            send({"id": value.get("id"), "error": "Не удалось озвучить реплику Supertonic."})
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
