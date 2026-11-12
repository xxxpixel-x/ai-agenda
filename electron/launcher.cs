using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Agenda")]
[assembly: AssemblyDescription("Agenda 桌面应用启动器")]
[assembly: AssemblyProduct("Agenda")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string runtime = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");

        try
        {
            if (!File.Exists(Path.Combine(root, "electron", "main.cjs")))
            {
                throw new InvalidOperationException(
                    "找不到 Agenda 的程序文件。\n\n请把“Agenda.exe”放回项目文件夹。" +
                    "如需从桌面打开，请给它创建快捷方式，不要单独移动这个文件。");
            }
            if (!File.Exists(runtime))
            {
                throw new InvalidOperationException(
                    "还没有安装桌面运行组件。\n\n请先双击项目文件夹中的“启动.cmd”完成首次安装，" +
                    "之后就可以直接双击“Agenda.exe”打开。");
            }

            // Resolve paths from the executable, even when opened through a shortcut.
            StringBuilder arguments = new StringBuilder(QuoteArgument(Path.Combine(root, ".")));
            foreach (string arg in args)
            {
                arguments.Append(' ').Append(QuoteArgument(arg));
            }

            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = runtime,
                Arguments = arguments.ToString(),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            // A parent developer tool may use Electron as Node; we need the desktop window.
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("无法启动桌面窗口，请重试。");
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Agenda 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // Windows command-line escaping: preserve spaces, quotes and trailing backslashes.
    private static string QuoteArgument(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append(c);
            }
            else
            {
                result.Append('\\', slashes).Append(c);
            }
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
