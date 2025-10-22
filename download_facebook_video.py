import sys
import os
import yt_dlp

def download_video(post_url, output_filename):
    """
    Downloads a video from a Facebook post URL using yt-dlp.
    """
    # Define the output path inside the 'downloads' directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    downloads_dir = os.path.join(script_dir, 'downloads')
    
    # Ensure the downloads directory exists
    if not os.path.exists(downloads_dir):
        os.makedirs(downloads_dir)
        
    output_path = os.path.join(downloads_dir, output_filename)

    # yt-dlp options
    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': output_path,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
    }

    try:
        print(f"Starting download from: {post_url}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([post_url])
        print(f"Successfully downloaded video to {output_path}")
        return True
    except Exception as e:
        print(f"Error downloading video: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python download_facebook_video.py <POST_URL> <OUTPUT_FILENAME>", file=sys.stderr)
        sys.exit(1)

    post_url_arg = sys.argv[1]
    output_filename_arg = sys.argv[2]
    
    success = download_video(post_url_arg, output_filename_arg)
    
    if not success:
        sys.exit(1)
