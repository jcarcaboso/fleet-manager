using System.Security.Cryptography;
using System.Text;

namespace Fleet.Core.Coordination;

/// <summary>How a Bundle digest is computed. A Managed file (<c>fleet.file/v1</c>) hashes the schema name and a NUL before its content.</summary>
public static class BundleDigests
{
    public const string FileSchema = "fleet.file/v1";

    /// <summary>Lowercase hex SHA-256 of <paramref name="content"/>, prefixed with <c>fleet.file/v1\0</c> for the file schema.</summary>
    public static string Sha256Hex(string schema, byte[] content)
    {
        var digestInput = schema == FileSchema
            ? Encoding.UTF8.GetBytes(FileSchema + "\0").Concat(content).ToArray()
            : content;
        return Convert.ToHexStringLower(SHA256.HashData(digestInput));
    }

    /// <summary>The digest of a Managed file as the publishers write it: <c>sha256:</c> and lowercase hex.</summary>
    public static string FileDigest(byte[] content) => "sha256:" + Sha256Hex(FileSchema, content);

    /// <summary>Whether <paramref name="expected"/> is the content's digest, with or without the <c>sha256:</c> prefix, ignoring case.</summary>
    public static bool Matches(string expected, string schema, byte[] content)
    {
        var hex = Sha256Hex(schema, content);
        return string.Equals(expected, hex, StringComparison.OrdinalIgnoreCase) || string.Equals(expected, "sha256:" + hex, StringComparison.OrdinalIgnoreCase);
    }
}
