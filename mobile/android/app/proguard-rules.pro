# R8 rules for the release build (minifyEnabled + shrinkResources).
# Capacitor core and its official plugins ship consumer ProGuard rules that
# keep their @CapacitorPlugin / @PluginMethod classes; nothing app-specific
# is reflected into from JavaScript, so no extra keep rules are needed.

# Keep line numbers so Play Console crash reports (with the uploaded
# mapping.txt) show real stack traces, but hide original source file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
