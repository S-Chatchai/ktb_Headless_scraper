# download_reel.py
import yt_dlp
import sys
import json
import os

if len(sys.argv) < 2:
    print(json.dumps({"videos": [], "caption": ""}))
    sys.exit(0)

url = sys.argv[1]

downloads_folder = os.path.join(os.path.dirname(__file__), "downloads")
os.makedirs(downloads_folder, exist_ok=True)

ydl_opts = {
    'outtmpl': os.path.join(downloads_folder, '%(id)s.%(ext)s'),
    'format': 'mp4',
    'quiet': True
}

video_paths = []
caption_text = ""

try:
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        # caption/title
        caption_text = info.get("description") or info.get("title") or ""
        if 'entries' in info:  # playlist หรือ multi-video
            for entry in info['entries']:
                video_paths.append(os.path.abspath(ydl.prepare_filename(entry)))
        else:
            video_paths.append(os.path.abspath(ydl.prepare_filename(info)))
except Exception as e:
    print(f"❌ Error downloading video: {e}", file=sys.stderr)

# ส่ง JSON กลับ Node.js
print(json.dumps({"videos": video_paths, "caption": caption_text}))
