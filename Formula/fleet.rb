class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.6.5"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-macos-arm64.tar.gz"
      sha256 "bf8c221fffd07abaa3a9fa09fcc1ec64b37de2dc5c17b0ecc28aafbb29431447"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-macos-amd64.tar.gz"
      sha256 "56dca35fd310c147d0e432f5f181965da700a7f3f41a20fcddb513ae31958135"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.6.5/fleet-linux-amd64.tar.gz"
    sha256 "c04c574dfc912ff295db8aa9cf821e5ca672849bb72106a2c138a68e83c20b6d"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.6.5", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
