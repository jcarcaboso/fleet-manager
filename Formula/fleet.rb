class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.3"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-macos-arm64.tar.gz"
      sha256 "f5512f5c963b8b00ca9e56e497bf49f453e2033d4b85b09708ecd89dd9ff0891"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-macos-amd64.tar.gz"
      sha256 "43bf26ba131bb1d0d8b07e583b1054c91c19af8e9b42e9b265d6988f6e2f82d9"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.3/fleet-linux-amd64.tar.gz"
    sha256 "96bb459a28efd77f6568836c33201a76fc5198bdd62ed6c4b8b5ca9a99164607"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.3", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
