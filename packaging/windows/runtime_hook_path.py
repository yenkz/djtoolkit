"""Runtime hook: prepend bundled bin/ to PATH so fpcalc.exe is discoverable."""
import os
import sys

if getattr(sys, "frozen", False):
    bundle_dir = os.path.dirname(sys.executable)
    bin_dir = os.path.join(bundle_dir, "bin")
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
