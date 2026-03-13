class Djtoolkit < Formula
  desc "DJ music library toolkit — download, fingerprint, tag, and manage tracks"
  homepage "https://github.com/yenkz/djtoolkit"
  license "MIT"
  version "__VERSION__"

  url "https://github.com/yenkz/djtoolkit/releases/download/v__VERSION__/djtoolkit-__VERSION__-arm64.tar.gz"
  sha256 "__SHA256_ARM64__"

  depends_on "chromaprint"
  depends_on :macos

  def install
    bin.install "djtoolkit"
  end

  test do
    assert_match "djtoolkit", shell_output("#{bin}/djtoolkit --help")
  end
end
