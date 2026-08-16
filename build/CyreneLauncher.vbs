' Cyrene Agent 启动脚本（随安装包部署到安装根目录）
' 双击即可在后台静默启动昔涟，不显示任何终端窗口
Set ws = CreateObject("Wscript.Shell")
ws.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ws.Run """" & ws.CurrentDirectory & "Cyrene.exe""", 0, False
