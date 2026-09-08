class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.4.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-macos-arm64.tar.gz"
      sha256 "4a78cec01f350b643e9819eeda72ab0eb8437d7a88ff657e02cc3c60a4e7c59d"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-macos-amd64.tar.gz"
      sha256 "7fe52a88ec6cb1773d4658d12c763f5aa880a9ff06cbd9b28db8508de1f847cb"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.4.0/fleet-linux-amd64.tar.gz"
    sha256 "5792fe2e091f25015fc8c68d6c2e94d84fe067904f54643b32b300eed16339ee"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.4.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
