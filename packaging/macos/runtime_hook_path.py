"""PyInstaller runtime hook — prepend bundled bin/ to PATH so fpcalc is found."""
import os
import sys

if getattr(sys, "frozen", False):
    bin_dir = os.path.join(sys._MEIPASS, "bin")
    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
