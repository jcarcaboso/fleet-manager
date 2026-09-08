using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;

namespace Fleet.Server.Source;

internal sealed record SourceFile(string Path, byte[] Content, bool Executable);

internal static class BundleEncoder
{
    private static readonly byte[] Magic = "FLTB1\0"u8.ToArray();

    public static SnapshotBundle Encode(string name, IReadOnlyList<SourceFile> files)
    {
        using var stream = new MemoryStream();
        stream.Write(Magic);
        WriteInt32(stream, files.Count);
        foreach (var file in files.OrderBy(x => Encoding.UTF8.GetBytes(x.Path), ByteArrayComparer.Instance))
        {
            var path = Encoding.UTF8.GetBytes(file.Path);
            WriteInt32(stream, path.Length);
            stream.Write(path);
            stream.WriteByte(file.Executable ? (byte)1 : (byte)0);
            WriteInt64(stream, file.Content.LongLength);
            stream.Write(file.Content);
        }

        var bytes = stream.ToArray();
        var digest = $"sha256:{Convert.ToHexStringLower(SHA256.HashData(bytes))}";
        return new SnapshotBundle(digest, "fleet.bundle/v1", bytes.LongLength, bytes);
    }

    public static long EncodedSize(IReadOnlyList<SourceFile> files)
    {
        var size = checked((long)Magic.Length + 4);
        foreach (var file in files)
            size = checked(size + 4 + Encoding.UTF8.GetByteCount(file.Path) + 1 + 8 + file.Content.LongLength);
        return size;
    }

    private static void WriteInt32(Stream stream, int value)
    {
        Span<byte> bytes = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        stream.Write(bytes);
    }

    private static void WriteInt64(Stream stream, long value)
    {
        Span<byte> bytes = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(bytes, value);
        stream.Write(bytes);
    }

    private sealed class ByteArrayComparer : IComparer<byte[]>
    {
        public static readonly ByteArrayComparer Instance = new();
        public int Compare(byte[]? left, byte[]? right)
        {
            if (ReferenceEquals(left, right)) return 0;
            if (left is null) return -1;
            if (right is null) return 1;
            return left.AsSpan().SequenceCompareTo(right);
        }
    }
}
