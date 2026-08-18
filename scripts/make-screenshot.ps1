# Renders assets/screenshot-1.png — a clean sample of the reference_check
# report (what the agent shows the user after a run).
#
# Regenerate with (Windows PowerShell 5.1 or pwsh):
#   & .\scripts\make-screenshot.ps1
#
# NOTE: this script is deliberately ASCII-only so Windows PowerShell 5.1
# parses it correctly. All visible text lives in assets/screenshot-data.json
# (UTF-8, read explicitly with -Encoding UTF8).
Add-Type -AssemblyName System.Drawing

$data = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\assets\screenshot-data.json') | ConvertFrom-Json

$W, $H = 1440, 800
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$white  = [System.Drawing.Color]::White
$bg     = [System.Drawing.Color]::FromArgb(248, 250, 252)
$ink    = [System.Drawing.Color]::FromArgb(31, 35, 40)
$sub    = [System.Drawing.Color]::FromArgb(88, 96, 105)
$line   = [System.Drawing.Color]::FromArgb(208, 215, 222)
$green  = [System.Drawing.Color]::FromArgb(26, 127, 55)
$red    = [System.Drawing.Color]::FromArgb(207, 34, 46)
$amber  = [System.Drawing.Color]::FromArgb(180, 83, 9)

$FTitle = New-Object System.Drawing.Font("Microsoft YaHei UI", 21, [System.Drawing.FontStyle]::Bold)
$FBody  = New-Object System.Drawing.Font("Microsoft YaHei UI", 14)
$FSub   = New-Object System.Drawing.Font("Microsoft YaHei UI", [float]12.5)
$FCode  = New-Object System.Drawing.Font("Consolas", [float]13.5)

# card
$brushBg = New-Object System.Drawing.SolidBrush($bg)
$g.FillRectangle($brushBg, 24, 24, $W - 48, $H - 48)
$brushWhite = New-Object System.Drawing.SolidBrush($white)
$g.FillRectangle($brushWhite, 48, 48, $W - 96, $H - 96)
$penLine = New-Object System.Drawing.Pen($line, 1)
$g.DrawRectangle($penLine, [float]47.5, [float]47.5, $W - 95, $H - 95)

$brushInk    = New-Object System.Drawing.SolidBrush($ink)
$brushSub    = New-Object System.Drawing.SolidBrush($sub)
$brushWhite2 = New-Object System.Drawing.SolidBrush($white)

function Draw-RoundedChip($g, $x, $y, $w, $h, $color, $glyph, $glyphBrush, $font) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $h, $h, 90, 180)
    $path.AddArc($x + $w - $h, $y, $h, $h, 270, 180)
    $path.CloseFigure()
    $b = New-Object System.Drawing.SolidBrush($color)
    $g.FillPath($b, $path)
    $sz = $g.MeasureString($glyph, $font)
    $g.DrawString($glyph, $font, $glyphBrush, $x + ($w - $sz.Width) / 2, $y + ($h - $sz.Height) / 2)
    $path.Dispose(); $b.Dispose()
}

function Wrap-Text($g, $text, $font, $maxW) {
    # Word-boundary wrap for ASCII runs (spaces preserved), character-level
    # for CJK. Tokens carry their preceding separator so output keeps the
    # original spacing.
    $tokens = New-Object System.Collections.ArrayList
    $sb = ''
    $pending = ''
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if ($code -gt 32 -and $code -le 126) { $sb += $ch }
        else {
            if ($sb) { [void]$tokens.Add([pscustomobject]@{ Pre = $pending; Text = $sb }); $sb = '' }
            if ($code -eq 32 -or $code -eq 9) { $pending = ' ' }
            else {
                [void]$tokens.Add([pscustomobject]@{ Pre = $pending; Text = [string]$ch })
                $pending = ''
            }
        }
    }
    if ($sb) { [void]$tokens.Add([pscustomobject]@{ Pre = $pending; Text = $sb }) }

    $lines = New-Object System.Collections.ArrayList
    $cur = ''
    foreach ($tk in $tokens) {
        $unit = $tk.Pre + $tk.Text
        if (($g.MeasureString($cur + $unit, $font).Width -le $maxW)) { $cur += $unit; continue }
        # doesn't fit on the current line
        if ($cur.Trim().Length -gt 0) { [void]$lines.Add($cur.TrimEnd()); $cur = '' }
        if (($g.MeasureString($tk.Text, $font).Width -le $maxW)) { $cur = $tk.Text }
        else {
            # token alone too wide → character-split (CJK / long URLs)
            foreach ($ch in $tk.Text.ToCharArray()) {
                if (($g.MeasureString($cur + $ch, $font).Width -gt $maxW) -and $cur.Length -gt 0) {
                    [void]$lines.Add($cur.TrimEnd()); $cur = ''
                }
                $cur += $ch
            }
        }
    }
    if ($cur) { [void]$lines.Add($cur.TrimEnd()) }
    return $lines
}

$M = 76   # left/right margin inside the white card
$X = $M
$MaxW = $W - 2 * $M

# header
$y = 84
$g.DrawString($data.header, $FTitle, $brushInk, $X, $y)
$y += 52
$g.DrawString($data.subtitle, $FSub, $brushSub, $X, $y)
$y += 40

# summary chips
$chipY = $y
$chipH = 30
$chipW = 130
$g.DrawString($data.summaryLabel, $FSub, $brushSub, $X, $chipY + 6)
$cx = $X + 110
Draw-RoundedChip $g $cx $chipY $chipW $chipH $green $data.chipFound   $brushWhite2 $FSub
$cx += $chipW + 12
Draw-RoundedChip $g $cx $chipY $chipW $chipH $amber $data.chipPartial $brushWhite2 $FSub
$cx += $chipW + 12
Draw-RoundedChip $g $cx $chipY $chipW $chipH $red   $data.chipNot     $brushWhite2 $FSub
$y = $chipY + $chipH + 26

$g.DrawLine($penLine, $M, $y, $W - $M, $y)
$y += 16

# result rows
$colChip = $M
$colRef  = $M + 160
$colBest = $M + 780
$colWRef  = $colBest - $colRef - 24
$colWBest = $W - $M - $colBest - 8

foreach ($r in $data.rows) {
    $col = $green; $glyph = $data.chipGlyphFound + ' ' + $r.status
    if ($r.status -ne 'found') { $col = $red; $glyph = $data.chipGlyphNot + ' ' + $r.status }
    $gw = 140
    Draw-RoundedChip $g $colChip $y $gw 28 $col $glyph $brushWhite2 $FSub

    $rl = @(Wrap-Text $g $r.ref $FBody ($colWRef - 8))
    $rl = $rl[0..[Math]::Min(1, $rl.Count - 1)]
    $g.DrawString($rl[0], $FBody, $brushInk, $colRef, $y + 2)
    $ly = $y + 2
    if ($rl.Count -gt 1) { $g.DrawString($rl[1], $FBody, $brushInk, $colRef, $ly + 24); $ly += 24 }

    $bl = @(Wrap-Text $g $r.best $FSub $colWBest)
    $bl = $bl[0..[Math]::Min(2, $bl.Count - 1)]
    $g.DrawString($bl[0], $FSub, $brushSub, $colBest, $y + 3)
    $by = $y + 3
    for ($i = 1; $i -lt $bl.Count; $i++) { $g.DrawString($bl[$i], $FSub, $brushSub, $colBest, $by + 22); $by += 22 }

    $rowH = [Math]::Max(34, [Math]::Max($rl.Count, $bl.Count) * 24 + 12)
    $y += $rowH + 10
    $g.DrawLine($penLine, $M, $y - 6, $W - $M, $y - 6)
}
$y += 14

# corrected citation block
$g.DrawString($data.correctedLabel, $FSub, $brushSub, $X, $y)
$y += 28
$cl = @(Wrap-Text $g $data.corrected $FCode ($MaxW - 8))
foreach ($l in $cl) { $g.DrawString($l, $FCode, $brushInk, $X, $y); $y += 26 }

# footer
$g.DrawString($data.footer, $FSub, $brushSub, $X, $H - 86)

$out = Join-Path $PSScriptRoot '..\assets\screenshot-1.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ("wrote " + $out + " (" + $W + " x " + $H + ")")
