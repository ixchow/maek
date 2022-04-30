# Maek

**Maek** is like **make**, but a bit mixed up.

**Maek** is a lightweight build system as a single javascript file. It is:
 - *Transparent*: everything is in one file and uses only standard node modules. You control exactly what maek does. No spooky action-at-a-distance or system package databases.
 - *Explicit*: prints the commands it runs and tells you why it runs them.
 - *Parallel*: runs many jobs at once.
 - *Incremental*: uses content hashes to decide which tasks to run.
 - *Extensible*: it's one javascript file. Hack it to add more!
 - *Readable*: the file tells you how to use it. Just open it in a text editor.

**Maek** is proudly *not* enterprise-grade software. It's meant for independent hackers and small teams who are fed up with features, fine with hacks, and just want `make` but cross-platform and less error-prone.

## Using Maek
To use **Maek** in your project, copy `Maekfile.js` from this repository into your project, then edit the file to customize the tasks and build rules.

Build the default target:
```
$ node Maekfile.js
```

Build some specific targets:
```
$ node Maekfile.js objs/Game.o :test
```
