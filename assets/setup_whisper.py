"""Install only the runtime; use the model already downloaded by Astra."""
import json
import subprocess
import sys
import venv
from pathlib import Path


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        folder = Path(sys.argv[1]) / "whisper-env"
        send({"status": "Создаём отдельное окружение Whisper…"})
        venv.EnvBuilder(with_pip=True).create(folder)
        python = folder / "Scripts" / "python.exe"
        send({"status": "Устанавливаем движок Whisper. Модель Astra повторно не скачивается…"})
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                        "--only-binary=:all:", "pywhispercpp==1.5.1"],
                       stdout=sys.stderr, stderr=sys.stderr, check=True, timeout=480)
        send({"ready": True, "python": str(python)})
        return 0
    except Exception:
        send({"error": "Не удалось подготовить Whisper. Нужен Python 3.10–3.14 x64 и доступ к PyPI."})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
