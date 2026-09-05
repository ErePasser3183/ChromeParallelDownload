"""A separate directory dialog keeps Native Messaging responsive while it is open."""
import json
import sys


def choose():
    import tkinter as tk
    from tkinter import filedialog

    window = tk.Tk()
    window.withdraw()
    window.attributes('-topmost', True)
    try:
        return filedialog.askdirectory(
            parent=window, title='选择多线程下载保存目录',
            initialdir=sys.argv[1] if len(sys.argv) > 1 else None,
            mustexist=True,
        )
    finally:
        window.destroy()


if __name__ == '__main__':
    try:
        print(json.dumps({'directory': choose()}, ensure_ascii=True), flush=True)
    except Exception:
        print(json.dumps({'error': 'directory_dialog_unavailable'}), flush=True)
        sys.exit(1)
