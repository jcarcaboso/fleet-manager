class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.13.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-macos-arm64.tar.gz"
      sha256 "2a964cddb3fbe195225d76d3b9556399e31c7ade1fdcfb93f38279f1ec399be2"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-macos-amd64.tar.gz"
      sha256 "fcb4d14557014c4b58e524716da1062f8f88ce664c6cfc9b769800233f69d079"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.13.0/fleet-linux-amd64.tar.gz"
    sha256 "7337b438365e0dfa989803a12dfa5bfc609333f62aaf003e91dd8bd634788e9f"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.13.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
