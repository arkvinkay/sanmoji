; Migrate SanMoji app data when the bundle identifier changed (v1.0.0 → v1.0.1).
; Runs after files are installed. Copies only when the new data folder has no settings yet.
; If this hook does not run (portable/dev), the app offers an interactive import on first launch.

!macro NSIS_HOOK_POSTINSTALL
  ReadEnvStr $0 APPDATA
  StrCpy $1 "$0\id.arkvin.sanmoji.app"
  StrCpy $2 "$0\id.app.arkvin.sanmoji"

  IfFileExists "$1\settings.json" 0 skip_roaming
  IfFileExists "$2\settings.json" skip_roaming 0
    CreateDirectory "$2"
    CopyFiles /SILENT "$1\settings.json" "$2"
    IfFileExists "$1\autosave.smpr" 0 +2
      CopyFiles /SILENT "$1\autosave.smpr" "$2"
    IfFileExists "$1\ffmpeg\ffmpeg.exe" 0 +3
      CreateDirectory "$2\ffmpeg"
      CopyFiles /SILENT "$1\ffmpeg\ffmpeg.exe" "$2\ffmpeg"
  skip_roaming:

  ReadEnvStr $0 LOCALAPPDATA
  StrCpy $1 "$0\id.arkvin.sanmoji.app\cache"
  StrCpy $2 "$0\id.app.arkvin.sanmoji\cache"

  IfFileExists "$1\*.*" 0 skip_cache
  IfFileExists "$2\*.*" skip_cache 0
    CreateDirectory "$2"
    CopyFiles /SILENT "$1\*.*" "$2"
  skip_cache:
!macroend