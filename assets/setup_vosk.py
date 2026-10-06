"""Prepare an isolated recognizer only after a click in the local plugin UI."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import urllib.request
import venv
import zipfile

MODEL_NAME = 'vosk-model-small-ru-0.22'
MODEL_URL = 'https://alphacephei.com/vosk/models/' + MODEL_NAME + '.zip'

def status(text):
    print(json.dumps({'status': text}, ensure_ascii=False), flush=True)

def main():
    root = Path(sys.argv[1]).resolve()
    environment = root / 'recognizer-env'
    models = root / 'models'
    archive = models / '.download-vosk.zip'
    try:
        status('Создаём отдельное окружение Python…')
        environment.mkdir(parents=True, exist_ok=True)
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / 'Scripts' / 'python.exe'
        status('Устанавливаем Vosk в окружение плагина…')
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', 'vosk==0.3.45'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = models / MODEL_NAME
        if not (target / 'am').is_dir():
            models.mkdir(parents=True, exist_ok=True)
            status('Скачиваем русскую модель, около 45 МБ…')
            size = 0
            with urllib.request.urlopen(MODEL_URL, timeout=45) as response, archive.open('wb') as output:
                while chunk := response.read(128 * 1024):
                    size += len(chunk)
                    if size > 80 * 1024 * 1024:
                        raise ValueError('Archive too large')
                    output.write(chunk)
            status('Проверяем и распаковываем модель…')
            with zipfile.ZipFile(archive) as package:
                total = 0
                for item in package.infolist():
                    path = (models / item.filename).resolve()
                    total += item.file_size
                    if not path.is_relative_to(models.resolve()) or not path.is_relative_to(target.resolve()) or stat.S_ISLNK(item.external_attr >> 16) or total > 250 * 1024 * 1024:
                        raise ValueError('Unsafe archive')
                package.extractall(models)
            if not (target / 'am').is_dir():
                raise ValueError('Incomplete model')
        status('Проверяем загрузку модели Vosk…')
        worker_directory = str(Path(__file__).resolve().parent)
        subprocess.run([str(python), '-c', 'import sys; sys.path.insert(0, sys.argv[1]); from vosk_worker import load_model; load_model(sys.argv[2])', worker_directory, str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(json.dumps({'ready': True, 'python': str(python), 'model': str(target)}, ensure_ascii=False), flush=True)
        return 0
    except Exception:
        print(json.dumps({'error': 'Не удалось подготовить Vosk. Проверьте установку Python и доступ к PyPI и alphacephei.com.'}, ensure_ascii=False), flush=True)
        return 1
    finally:
        if archive.exists() and archive.resolve().is_relative_to(root):
            archive.unlink()

if __name__ == '__main__':
    raise SystemExit(main())
