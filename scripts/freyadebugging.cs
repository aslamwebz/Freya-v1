using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace FreyaLauncher
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string electron = Path.Combine(root, @"node_modules\electron\dist\electron.exe");

            if (!File.Exists(electron))
            {
                MessageBox.Show("Electron executable not found at:\n" + electron, "Freya Debugging", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string appDir = root.TrimEnd('\\');
            string arguments = "\"" + appDir + "\" --dev --remote-debugging-port=9234 --remote-debugging-address=127.0.0.1";
            if (args != null && args.Length > 0)
            {
                arguments += " " + string.Join(" ", args);
            }

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = electron,
                Arguments = arguments,
                WorkingDirectory = root,
                UseShellExecute = false
            };

            try
            {
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start Freya:\n" + ex.Message, "Freya Debugging", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
