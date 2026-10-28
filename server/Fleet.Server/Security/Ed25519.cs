using System.Numerics;
using System.Security.Cryptography;

namespace Fleet.Server.Security;

/// <summary>
/// Ed25519 signature verification (RFC 8032, section 5.1.7) for the Agent release manifest. .NET has no Ed25519 API, and only
/// public data is handled here, so a straightforward big-integer implementation is enough: it runs once per mirrored release.
/// Like ring, which verifies the same signatures on the Agent, it rejects non-canonical scalars and encodings and compares the
/// encoding of <c>[S]B - [k]A</c> with <c>R</c>.
/// </summary>
public static class Ed25519
{
    public const int PublicKeyLength = 32;
    public const int SignatureLength = 64;

    private static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    private static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    private static readonly BigInteger D = Mod(-121665 * Inverse(121666));
    private static readonly BigInteger SqrtMinusOne = BigInteger.ModPow(2, (P - 1) / 4, P);
    private static readonly Point B = Base();

    // DER SubjectPublicKeyInfo prefix of an Ed25519 key: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (33 bytes) }.
    private static readonly byte[] SpkiPrefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

    /// <summary>The raw 32-byte key from a PEM <c>PUBLIC KEY</c> block, as <c>openssl pkey -pubout</c> writes it.</summary>
    public static byte[] PublicKeyFromPem(string pem)
    {
        const string begin = "-----BEGIN PUBLIC KEY-----", end = "-----END PUBLIC KEY-----";
        var start = pem.IndexOf(begin, StringComparison.Ordinal);
        var stop = pem.IndexOf(end, StringComparison.Ordinal);
        if (start < 0 || stop < start || pem.Contains("PRIVATE KEY", StringComparison.Ordinal))
            throw new FormatException("An Ed25519 public key must be one PEM PUBLIC KEY block.");
        var der = Convert.FromBase64String(pem[(start + begin.Length)..stop].Trim());
        if (der.Length != SpkiPrefix.Length + PublicKeyLength || !der.AsSpan(0, SpkiPrefix.Length).SequenceEqual(SpkiPrefix))
            throw new FormatException("The PEM public key is not an Ed25519 key.");
        return der[SpkiPrefix.Length..];
    }

    public static bool Verify(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (publicKey.Length != PublicKeyLength || signature.Length != SignatureLength) return false;
        if (Decode(publicKey) is not { } a) return false;
        var s = Little(signature[32..]);
        if (s >= L) return false;
        var hash = SHA512.HashData([.. signature[..32], .. publicKey, .. message]);
        var k = Mod(Little(hash), L);
        var check = Add(Multiply(B, s), Multiply(Negate(a), k));
        return Encode(check).AsSpan().SequenceEqual(signature[..32]);
    }

    // Extended homogeneous coordinates: x = X/Z, y = Y/Z, x*y = T/Z.
    private readonly record struct Point(BigInteger X, BigInteger Y, BigInteger Z, BigInteger T);

    private static Point Base()
    {
        var y = Mod(4 * Inverse(5));
        return Decode(EncodeY(y, false)) ?? throw new InvalidOperationException("Invalid Ed25519 base point.");
    }

    private static Point Add(Point p, Point q)
    {
        var a = Mod((p.Y - p.X) * (q.Y - q.X));
        var b = Mod((p.Y + p.X) * (q.Y + q.X));
        var c = Mod(2 * D * p.T * q.T);
        var d = Mod(2 * p.Z * q.Z);
        var (e, f, g, h) = (b - a, d - c, d + c, b + a);
        return new(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
    }

    private static Point Multiply(Point p, BigInteger scalar)
    {
        var result = new Point(0, 1, 1, 0);
        while (scalar > 0)
        {
            if (!scalar.IsEven) result = Add(result, p);
            p = Add(p, p);
            scalar >>= 1;
        }
        return result;
    }

    private static Point Negate(Point p) => new(Mod(-p.X), p.Y, p.Z, Mod(-p.T));

    private static Point? Decode(ReadOnlySpan<byte> bytes)
    {
        var sign = (bytes[31] & 0x80) != 0;
        Span<byte> copy = stackalloc byte[32];
        bytes.CopyTo(copy);
        copy[31] &= 0x7f;
        var y = Little(copy);
        if (y >= P) return null;
        var u = Mod(y * y - 1);
        var v = Mod(D * y * y + 1);
        var x2 = Mod(u * Inverse(v));
        if (x2.IsZero)
        {
            if (sign) return null;
            return new(0, y, 1, 0);
        }
        var x = BigInteger.ModPow(x2, (P + 3) / 8, P);
        if (Mod(x * x - x2) != 0) x = Mod(x * SqrtMinusOne);
        if (Mod(x * x - x2) != 0) return null;
        if (!x.IsEven != sign) x = P - x;
        return new(x, y, 1, Mod(x * y));
    }

    private static byte[] Encode(Point p)
    {
        var inverse = Inverse(p.Z);
        return EncodeY(Mod(p.Y * inverse), !Mod(p.X * inverse).IsEven);
    }

    private static byte[] EncodeY(BigInteger y, bool odd)
    {
        var bytes = new byte[32];
        y.TryWriteBytes(bytes, out _, isUnsigned: true, isBigEndian: false);
        if (odd) bytes[31] |= 0x80;
        return bytes;
    }

    private static BigInteger Little(ReadOnlySpan<byte> bytes) => new(bytes, isUnsigned: true, isBigEndian: false);

    private static BigInteger Mod(BigInteger value) => Mod(value, P);

    private static BigInteger Mod(BigInteger value, BigInteger modulus)
    {
        var result = BigInteger.Remainder(value, modulus);
        return result.Sign < 0 ? result + modulus : result;
    }

    private static BigInteger Inverse(BigInteger value) => BigInteger.ModPow(Mod(value), P - 2, P);
}
