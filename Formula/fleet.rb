class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.15.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-macos-arm64.tar.gz"
      sha256 "4fbd134e875700b93491153047a0fc3e70ec5797ad1ab1330e4b6840d706f780"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-macos-amd64.tar.gz"
      sha256 "cd36830fd56a15b08f72e0770d81e6885cd6b7f98c1d2fc567149e3aae2c1f74"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-linux-arm64.tar.gz"
      sha256 "875d8bacfc456758949a328edec5b09499493098f4aab747f1e674c7bef8801d"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.15.0/fleet-linux-amd64.tar.gz"
      sha256 "959af1c5ff19b1306ec171ab37e5a97ffa1093ce0ef3b5c8ac1dd6143fa607e9"
    end
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.15.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
