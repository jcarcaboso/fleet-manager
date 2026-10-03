class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.8.1"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-macos-arm64.tar.gz"
      sha256 "2e87e4f26a6ea02c4c19dea1a6929fa2e3de9ab5b50db79dd7698ba9365e6f3b"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-macos-amd64.tar.gz"
      sha256 "6a7b1deafdb49beb26ea5c5b328c98c72b2f8831a9bd1aa3322b34dfc23b5928"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.8.1/fleet-linux-amd64.tar.gz"
    sha256 "0d72597221a2b7508d1b38cb27399904bbd6f3ab44617630c4172556d784194f"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.8.1", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
