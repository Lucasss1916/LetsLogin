@echo off
chcp 65001 >nul
title Apex Cfg Tool
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apex_cfg_tool.ps1"
pause
