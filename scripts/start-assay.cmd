@echo off
rem Keeps the Assay prober alive: relaunches on crash with a 15s backoff.
rem Logs append to data\assay.log (gitignored). Started at logon via start-assay-hidden.vbs.
cd /d C:\Users\Jason\Coding\assay
:loop
echo [%date% %time%] starting assay >> data\assay.log
call npx tsx src/index.ts >> data\assay.log 2>&1
echo [%date% %time%] assay exited (code %errorlevel%) - restarting in 15s >> data\assay.log
timeout /t 15 /nobreak > nul
goto loop
