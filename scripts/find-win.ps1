Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinUtil2 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> Find(uint[] pids) {
    var results = new List<string>();
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      foreach (var target in pids) {
        if (pid == target) {
          bool vis = IsWindowVisible(hWnd);
          StringBuilder sb = new StringBuilder(256);
          GetWindowText(hWnd, sb, 256);
          RECT r;
          GetWindowRect(hWnd, out r);
          results.Add("PID: " + pid + " Vis: " + vis + " HWND: " + hWnd + " Title: '" + sb.ToString() + "' Rect: [" + r.Left + "," + r.Top + " -> " + r.Right + "," + r.Bottom + "]");
        }
      }
      return true;
    }, IntPtr.Zero);
    return results;
  }
}
"@
$freyaPids = (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq 143400 -or $_.ParentProcessId -eq 143400 }).ProcessId
$res = [WinUtil2]::Find([uint32[]]$freyaPids)
foreach ($r in $res) {
  Write-Output $r
}
