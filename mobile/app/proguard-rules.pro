# R8 rules for the release build (MOB-20). R8 runs in FULL mode (AGP 8 default).
#
# Gson reads and writes fields BY NAME, through reflection, and this app's models carry no
# @SerializedName (test/mobile-api.js refuses it). An obfuscated field is therefore a field
# the server's JSON never fills: every value null, with the build green. So every class in
# models.kt is kept whole, and test/runtime.test.js holds this list equal to models.kt.
# android.yml additionally reads the BUILT dex and fails if a field name did not survive.
-keep class ink.etech.gametracker.LoginRequest { *; }
-keep class ink.etech.gametracker.LoginResponse { *; }
-keep class ink.etech.gametracker.CreateTokenRequest { *; }
-keep class ink.etech.gametracker.CreatedToken { *; }
-keep class ink.etech.gametracker.Game { *; }
-keep class ink.etech.gametracker.GameUpdateRequest { *; }
-keep class ink.etech.gametracker.BacklogReorderRequest { *; }
-keep class ink.etech.gametracker.GameUpsertResult { *; }

# Gson: generic types (List<Game>) are read from signatures.
-keepattributes Signature, InnerClasses, EnclosingMethod, *Annotation*
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken

# Retrofit builds the API from the interface's annotations and generic return types, at run
# time. Retrofit 2.9.0's bundled rules predate R8 full mode and suspend functions, so these
# are the ones later Retrofit releases ship.
-keep interface ink.etech.gametracker.GameTrackerApi { *; }
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations, AnnotationDefault
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-dontwarn org.codehaus.mojo.animal_sniffer.IgnoreJRERequirement
-dontwarn javax.annotation.**
-dontwarn kotlin.Unit
-dontwarn retrofit2.KotlinExtensions
-dontwarn retrofit2.KotlinExtensions$*

# Crash reports keep line numbers; the source file name is hidden.
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile
