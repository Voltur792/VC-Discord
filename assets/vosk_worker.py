"""Local-only recognizer. Audio and results travel over this child's pipes."""
import argparse
import base64
import json
import os
from pathlib import Path
import sys

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def load_model(model_path):
    from vosk import Model, SetLogLevel
    directory = Path(model_path).resolve(strict=True)
    if not directory.is_dir():
        raise NotADirectoryError(directory)
    # Vosk's Windows native library cannot open UTF-8 absolute paths containing
    # Cyrillic. Python changes the Unicode working directory; Vosk receives ASCII.
    os.chdir(directory)
    SetLogLevel(-1)
    return Model('.')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    try:
        from vosk import KaldiRecognizer
        model = load_model(args.model)
    except ImportError:
        emit({'error': 'package_missing'})
        return 1
    except (FileNotFoundError, NotADirectoryError):
        emit({'error': 'model_missing'})
        return 1
    except Exception:
        emit({'error': 'model_load_failed'})
        return 1
    emit({'ready': True})
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 2_000_000:
                raise ValueError('Audio too large')
            request = json.loads(line)
            audio = base64.b64decode(request['audio'], validate=True)
            recognizer = KaldiRecognizer(model, 16000)
            # Split frames: Vosk may produce final segments inside a long utterance.
            parts = []
            for start in range(0, len(audio), 8000):
                if recognizer.AcceptWaveform(audio[start:start + 8000]):
                    parts.append(json.loads(recognizer.Result()).get('text', ''))
            parts.append(json.loads(recognizer.FinalResult()).get('text', ''))
            emit({'id': request.get('id'), 'text': ' '.join(p for p in parts if p)})
        except Exception:
            emit({'id': request.get('id'), 'error': 'Recognition failed'})
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
