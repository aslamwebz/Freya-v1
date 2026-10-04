// Freya.exe — double-clickable native launcher.
// Same contract as Freya.cmd, but it is a GUI executable: no console window
// is ever created and no focus is stolen. Nothing is installed and nothing is
// copied; the working copy of the repository is the application.
//
// Build:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe -nologo -target:winexe -out:Freya.exe scripts\FreyaLauncher.cs

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class FreyaLauncher
{
    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
        string entry = Path.Combine(root, "dist-electron", "main.cjs");

        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "Freya's dependencies are not installed yet.\n\nOpen a terminal in:\n" + root + "\n\nand run:\n\n    npm install",
                "Freya", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        if (!File.Exists(entry))
        {
            MessageBox.Show(
                "Freya has not been built yet.\n\nOpen a terminal in:\n" + root + "\n\nand run:\n\n    npm run build",
                "Freya", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        // The app directory is the argument electron needs; the entry point it
        // looks for — dist-electron\main.cjs — is named in package.json.
        // The root ends in a backslash, so appending "." keeps a backslash from
        // sitting right before the closing quote, where it would escape the
        // quote and malform the argument. Same reasoning as Freya.cmd.
        Process.Start(new ProcessStartInfo
        {
            FileName = electron,
            Arguments = "\"" + root + ".\"",
            WorkingDirectory = root,
            UseShellExecute = true,
        });
        return 0;
    }
}
