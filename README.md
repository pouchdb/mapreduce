pouchdb.mapreduce.noeval
========================

MapReduce plugin for [PouchDB](https://github.com/daleharvey) that does not use dynamic evaluation
of JavaScript (`eval()` or `new Function()`). Thus, it allows using PouchDB in environments with
strict policy against dynamic script evaluation, such as Chrome Packaged Apps or Adobe AIR runtime.

Note that this kind of treatment is not required for Chrome Extensions or (now deprecated) Chrome
Apps using manifest in version 1. For these kind of applications, the content security policy
can be [relaxed](http://developer.chrome.com/extensions/contentSecurityPolicy.html#relaxing).

However, using `eval()` in new Chrome Apps would require putting the page using the script in a
sandbox, which in turn renders PouchDB unusable, as sandboxed page doesn't have access to IndexedDB.
Using this plugin is effectively the only way to use PouchDB in a packaged app without putting the
original MapReduce plugin in a sandbox and setting a wrapper around it to communicate with the
rest of library via `window.postMessage()` calls.

Usage
-----

Make sure this script is loaded *after* PouchDB. Then, modify your view functions, so they use
`this.emit()` instead of `emit()` call.

Limitations
-----------

PouchDB also uses dynamic evaluation for constructing change filter functions, if you specify them
as members of a design document. This functionality is hard to override, as it's enclosed in
internal routines. Pass actual function implementations as `filter` arguments to be on the safe
side.
