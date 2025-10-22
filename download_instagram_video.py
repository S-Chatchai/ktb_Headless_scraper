import yt_dlp
import os
import re
import sys

# Ensure downloads folder exists
os.makedirs("downloads", exist_ok=True)

def get_post_id(url: str):
    match = re.search(r"instagram\.com/(?:p|reel)/([a-zA-Z0-9_-]+)/?", url)
    return match.group(1) if match else "unknown_post"

def download_instagram_videos(url: str, custom_name: str = None):
    post_id = get_post_id(url)

    if custom_name:
        outtmpl = f"downloads/{custom_name}"
    else:
        outtmpl = f"downloads/{post_id}_%(autonumber)s.%(ext)s"

    ydl_opts = {
        "quiet": False,
        "outtmpl": outtmpl,
        "noplaylist": False,
        "ignoreerrors": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

        if not info:
            print("No media found in this post.")
            return []

        video_files = []
        if "entries" in info:  # Carousel
            for entry in info["entries"]:
                if entry and entry.get("is_video"):
                    video_files.append(ydl.prepare_filename(entry))
        else:  # Single post
            if info.get("is_video"):
                video_files.append(ydl.prepare_filename(info))

        return video_files

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python download_instagram_video.py <post_url> [custom_name]")
        sys.exit(1)

    post_url = sys.argv[1]
    custom_name = sys.argv[2] if len(sys.argv) > 2 else None
    downloaded_videos = download_instagram_videos(post_url, custom_name)

    for video_file in downloaded_videos:
        print(video_file)