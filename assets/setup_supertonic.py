"""Prepare the Python voice runtime in user data, independently of the source folder."""
import json
import subprocess
import sys
import venv
from pathlib import Path


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        folder = Path(sys.argv[1]) / "supertonic-env"
        send({"status": "Создаём окружение голоса в папке данных пользователя…"})
        venv.EnvBuilder(with_pip=True).create(folder)
        python = folder / "Scripts" / "python.exe"
        send({"status": "Устанавливаем Supertonic и зависимости. Модель голоса остаётся из Astra…"})
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                        "--only-binary=:all:", "supertonic==1.3.1"],
                       stdout=sys.stderr, stderr=sys.stderr, check=True, timeout=480)
        send({"ready": True, "python": str(python)})
        return 0
    except Exception:
        send({"error": "Не удалось подготовить Supertonic. Проверьте установленный Python и доступ к PyPI; либо укажите готовое окружение."})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
