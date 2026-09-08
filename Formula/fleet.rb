class Fleet < Formula
  desc "Operator CLI for Fleet Manager"
  homepage "https://github.com/jcarcaboso/fleet-manager"
  version "0.3.0"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-macos-arm64.tar.gz"
      sha256 "1fa9a213842fedb137a8751a689ee18a7d2b1f550602b1ea4dbd0534c249058f"
    else
      url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-macos-amd64.tar.gz"
      sha256 "acdc58b1b47616253959c1519e747e4f72bd3aff2f304b95a6df60ed91aeef83"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "https://github.com/jcarcaboso/fleet-manager/releases/download/v0.3.0/fleet-linux-amd64.tar.gz"
    sha256 "4c9e5c0707f110b932f8b4d4e6c6cf7efdb8211d0e8bed4639ba3b728a6cabf4"
  end

  def install
    bin.install "fleet"
  end

  test do
    assert_match "fleet 0.3.0", shell_output("#{bin}/fleet --version")
    system "#{bin}/fleet", "--help"
  end
end
