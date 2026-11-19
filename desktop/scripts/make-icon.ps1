$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$DesktopDir = Split-Path -Parent $PSScriptRoot
$AssetsDir = Join-Path $DesktopDir "assets"
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

$Source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;

public static class QuoteIconMaker {
    public static void Create(string pngPath, string icoPath) {
        using (var bitmap = new Bitmap(256, 256))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var path = new GraphicsPath())
        using (var brush = new LinearGradientBrush(
            new Rectangle(8, 8, 240, 240),
            Color.FromArgb(255, 10, 20, 38),
            Color.FromArgb(255, 13, 116, 144),
            45f))
        using (var accent = new Pen(Color.FromArgb(255, 77, 208, 181), 8f))
        using (var font = new Font("Microsoft YaHei UI", 92f, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var textBrush = new SolidBrush(Color.White))
        using (var format = new StringFormat())
        using (var dotBrush = new SolidBrush(Color.FromArgb(255, 250, 204, 21)))
        using (var dotPen = new Pen(Color.FromArgb(255, 10, 20, 38), 5f)) {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            var rect = new Rectangle(8, 8, 240, 240);
            const int radius = 44;
            path.AddArc(rect.X, rect.Y, radius, radius, 180, 90);
            path.AddArc(rect.Right - radius, rect.Y, radius, radius, 270, 90);
            path.AddArc(rect.Right - radius, rect.Bottom - radius, radius, radius, 0, 90);
            path.AddArc(rect.X, rect.Bottom - radius, radius, radius, 90, 90);
            path.CloseFigure();
            graphics.FillPath(brush, path);

            accent.StartCap = LineCap.Round;
            accent.EndCap = LineCap.Round;
            graphics.DrawLine(accent, 57, 79, 199, 79);
            graphics.DrawLine(accent, 57, 108, 174, 108);

            format.Alignment = StringAlignment.Center;
            format.LineAlignment = StringAlignment.Center;
            graphics.DrawString("\u4EF7", font, textBrush, new RectangleF(8, 105, 240, 125), format);
            graphics.FillEllipse(dotBrush, 184, 184, 38, 38);
            graphics.DrawEllipse(dotPen, 184, 184, 38, 38);

            bitmap.Save(pngPath, ImageFormat.Png);
            using (var icon = Icon.FromHandle(bitmap.GetHicon()))
            using (var stream = File.Create(icoPath)) {
                icon.Save(stream);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $Source -ReferencedAssemblies System.Drawing
[QuoteIconMaker]::Create(
  (Join-Path $AssetsDir "icon.png"),
  (Join-Path $AssetsDir "icon.ico")
)
Write-Host "Created application icon"
