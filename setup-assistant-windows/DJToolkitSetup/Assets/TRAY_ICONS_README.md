# Tray Icon Assets

Three `.ico` files are required for the system tray icon. They need to be created on Windows
(or via an icon tool like ImageMagick) with 16x16 and 32x32 sizes:

| File | Color | Hex | Meaning |
|------|-------|-----|---------|
| `tray-green.ico` | Green circle | `#4CAF50` | Agent is Running |
| `tray-gray.ico` | Gray circle | `#9E9E9E` | Agent is Stopped |
| `tray-yellow.ico` | Amber circle | `#FFC107` | Agent is Not Installed |

## Generating with ImageMagick (Windows PowerShell)

```powershell
# Install ImageMagick first: https://imagemagick.org/script/download.php#windows

$sizes = "16x16", "32x32"

foreach ($color in @("4CAF50:tray-green", "9E9E9E:tray-gray", "FFC107:tray-yellow")) {
    $hex, $name = $color -split ":"
    $pngs = $sizes | ForEach-Object {
        $tmp = "$env:TEMP\${name}_$_.png"
        magick convert -size $_ xc:"#$hex" -alpha set `
            \( +clone -threshold -1 -negate -fill "#$hex" -draw "circle $([int]($_.Split('x')[0])/2-1),$([int]($_.Split('x')[1])/2-1) $([int]($_.Split('x')[0])/2-1),1" \) `
            -compose DstIn -composite $tmp
        $tmp
    }
    magick convert $pngs "Assets\${name}.ico"
}
```

## Simpler approach (PowerShell + .NET)

```powershell
Add-Type -AssemblyName System.Drawing

function New-CircleIco($hex, $outPath) {
    $colors = @(16, 32) | ForEach-Object {
        $bmp = New-Object System.Drawing.Bitmap($_,$_)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = 'AntiAlias'
        $color = [System.Drawing.ColorTranslator]::FromHtml("#$hex")
        $brush = New-Object System.Drawing.SolidBrush($color)
        $g.FillEllipse($brush, 1, 1, $_-2, $_-2)
        $g.Dispose()
        $bmp
    }
    # Save as ICO (requires System.Drawing ICO encoder)
    $stream = [System.IO.File]::OpenWrite($outPath)
    # ICO header + frames ...
    $stream.Close()
}
```

## Placeholder

Until real icons are created, the tray icon will fall back to showing no icon (transparent).
The tooltip text will still show the agent status correctly.
