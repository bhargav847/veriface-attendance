@echo off
set SCRIPT="%TEMP%\%RANDOM%_shortcut.vbs"
set TARGET=%~dp0start_server.bat
set SHORTCUT=%USERPROFILE%\Desktop\Start VeriFace Server.lnk

echo Set oWS = WScript.CreateObject("WScript.Shell") >> %SCRIPT%
echo sLinkFile = "%SHORTCUT%" >> %SCRIPT%
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> %SCRIPT%
echo oLink.TargetPath = "%TARGET%" >> %SCRIPT%
echo oLink.WorkingDirectory = "%~dp0" >> %SCRIPT%
echo oLink.Description = "Start VeriFace Biometric Attendance Server" >> %SCRIPT%
echo oLink.Save >> %SCRIPT%

cscript /nologo %SCRIPT%
del %SCRIPT%

echo Desktop shortcut created: "Start VeriFace Server"
pause
