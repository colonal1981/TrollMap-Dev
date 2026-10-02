@echo off
rem Personal use only, not for distribution or resale; not for navigation.
rem Double-click to let the app ask Claude on this PC for plans. Leave the window open.
rem   claude_plan_bridge.bat --model sonnet   to use Sonnet instead of Opus (the default)
title TrollMap plan bridge (Claude)
cd /d "%~dp0.."
py Scripts\claude_plan_bridge.py %*
pause
