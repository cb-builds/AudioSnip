; Custom NSIS installer hooks - see https://v2.tauri.app/distribute/windows-installer/#hooks
; Referenced from tauri.conf.json's bundle.windows.nsis.installerHooks.

!macro NSIS_HOOK_POSTUNINSTALL
  ; Offers a clean-slate option once the app's files have already been
  ; removed - declining leaves settings.json (hotkeys, device selection,
  ; default volumes, tray/startup preferences) in place so a reinstall picks
  ; up right where the user left off; accepting wipes the app's entire
  ; AppData/Roaming directory (the same folder `app_data_dir()` resolves to
  ; on the Rust side).
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to delete your application data/settings?" IDNO keep_app_data
    RMDir /r "$APPDATA\com.audiosnip.app"
  keep_app_data:
!macroend
