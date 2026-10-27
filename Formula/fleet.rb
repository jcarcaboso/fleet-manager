class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.10.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-macos-arm64.tar.gz"
      sha256 "3ea12a830604000db36db58e8e3bba206b7ff85f4032e766d9d78a3da9a17e11"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-macos-amd64.tar.gz"
      sha256 "fd919afd4d1f1ffa5a1505ff8ac51d34fb2bbe886b62d0e3dc360179d6a74cc2"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.10.0/fleet-linux-amd64.tar.gz"
    sha256 "c71497e4a9a1f79a6a94db230666e4bfe146a33fa0bb173d6eed349af36df663"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.10.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
