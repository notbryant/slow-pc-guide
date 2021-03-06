//////////////////// Pre-import trickery ////////////////////

var fs = require('fs')
  , path = require('path');

//////////////////// Find wkhtmltopdf ////////////////////

var wkhtmltopdf_cmd;
if(fs.existsSync(path.join(__dirname, "wkhtmltopdf", "bin"))) {
  var os = require('os');
  var nixPath = path.join(__dirname, "wkhtmltopdf", "bin");
  if(os.platform()=="darwin")
    wkhtmltopdf_cmd = path.join(nixPath, "wkhtmltopdf_darwin_x86");
  else if(os.platform()=="linux") {
    if(os.arch()=="ia32")
      wkhtmltopdf_cmd = path.join(nixPath, "wkhtmltopdf_linux_x86");
    else if(os.arch()=="x64")
      wkhtmltopdf_cmd = path.join(nixPath, "wkhtmltopdf_linux_amd64");
  }
}
if(!wkhtmltopdf_cmd) {
  console.warn("WARNING: No bundled wkhtmltopdf could be found. Your system's version may produce very large PDF files.");
}

//////////////////// cli-args ////////////////////

var argv = ['gh-pages', 'skipassets', 'md', 'html', 'pdf', 'epub']
if(process.argv.indexOf("-d") >= 0) {
  process.argv.splice(process.argv.indexOf("-d"), 1);
  fs.writeFile = function(f, d, options, callback) { (callback || options)(); };
}

if(process.argv.length > 2) {
  if(process.argv.indexOf("-h")>=0 || process.argv.indexOf("--help")>=0) {
    console.log("Usage:",
                process.argv[0],
                require('path').basename(process.argv[1]),
                '[' + argv.join(', ') + ']');
    process.exit(0);
  }
  argv = process.argv.slice(2).map(function (val, index, array) {
    if(argv.indexOf(val) == -1)
      throw(new Error("Invalid argument: " + val));
    return val;
  });
} else {
  argv.splice(argv.indexOf("skipassets"), 1)
}
argv.contains = function(thing) { return this.indexOf(thing) >= 0};


//////////////////// Imports ////////////////////

// Project files
for(var v in require(__dirname + "/util.js"))
  global[v] = require(__dirname + "/util.js")[v];

var mdit_plugins = require(__dirname + '/markdown-it_plugins.js'),
    slugify = mdit_plugins.anchor.defaults.slugify;

// npm packages
var mkdirp = require('mkdirp')
  , Promise = (global.Promise || require('promiscuous'))
  , Epub = require("epub-builder")
  , markdown_it = require('markdown-it')
  , wkhtmltopdf = require('wkhtmltopdf', {command: wkhtmltopdf_cmd})
  , mimeTypes = require('mime-types')
  , frontmatter = require('front-matter')
  , uuid = require('node-uuid')
  , clone = require('clone')
  , mdtoc = function(md) { return require('markdown-toc')(md, {slugify: slugify}) }
  , beautify = function(x) { return x};
try {
  // (Optional) This module will make exported HTML easy on the eyes.
  beautify = require('js-beautify').html
  beautify()
} catch(e) {}


//////////////////// Setup the environment ////////////////////


var buildConfig = require(__dirname + "/config.json");
if(!buildConfig.uuid) {
  buildConfig.uuid = uuid.v4();
  fs.writeFileSync(__dirname + "/config.json", JSON.stringify(buildConfig, null, '  '));
}

process.chdir(path.resolve(__dirname, buildConfig.working_dir));

// Paths
var buildDir = __dirname,
    websiteDir = path.resolve(process.cwd(), "dist"),
    ebookDir = path.resolve(websiteDir, "ebook"),
// Useful vars
    meta = {},
    tocIndex = TocIndex({specialSlugs: ['table-of-contents']})
// Styles available for HTML exporting
  themes = {
  "github":           "github-markdown-css/github-markdown.css",
  "avenir-white":     "markdown-css-themes/avenir-white.css",
  "foghorn":          "markdown-css-themes/foghorn.css",
  "swiss":            "markdown-css-themes/swiss.css",
  //https://github.com/markdowncss/air
}, chosenTheme = "github"
, fileContents = {
  theme:          path.join(websiteDir, "themes", themes[chosenTheme]),
  template:       path.join(buildDir, "templ.html"),
  title_template: path.join(buildDir, "title_templ.html"),
  "style.css":    path.join(buildDir, "style.css"),
  "logo.png":     path.join(buildDir, "..", "logo.png"),
  "favicon.png":  path.join(buildDir, "favicon.png"),
}; // images [png,jpg,gif,webp] are stored as browser-ready base64, everything else is text


/////////////////////////////////////////////////////////////////
//////////////////// Start the promise chain ////////////////////
/////////////////////////////////////////////////////////////////


// 0. Read meta frontmatter, make output directories
new Promise(function(resolve, reject) {
  fs.readFile(buildConfig.meta_file, "utf-8", vow(resolve, reject));
}).then(function(fileData) {
  var fm = frontmatter(fileData).attributes;
  if(Object.keys(fm).length===0)
    throw new Error("No meta info found")
  Object.keys(fm).forEach(function(key) {
    meta[key.toLowerCase()] = fm[key];
  });
  return mkdirp(ebookDir);
})
// 1. Read file contents
.then(function() {
  return Promise.all(Object.keys(fileContents).map(function(filename) {
    var isImage = /\.(png|jpg|gif|webp)$/i.test(filename);
    return new Promise(function(resolve, reject) {
      fs.readFile(fileContents[filename],
        {encoding: isImage ? null : 'utf-8'},
        vow(resolve, reject));
    }).then(function(data) {
      fileContents[filename] = isImage ? base64img(data, mimeTypes.lookup(filename)) : data;
    });
  }));
})
// 2. Read ALL the chapters! Also generate TocIndex at the same time
.then(function() {
  return Promise.all(buildConfig.files.map(function(filename) {
    return new Promise(function(resolve, reject) {
      fs.readFile(filename, {encoding: 'utf8'}, function(err, data) {
        if(err) return reject(err);
        mdtoc(data).json.forEach(function(tocEntry) {
          tocIndex.put(slugify(tocEntry.content), readme2index(filename, ".html"))
        });
        resolve(data);
      });
    })
  }))
})
// 3. Create the Github Pages versions
.then(function(fileContentsArray) {
  if(!argv.contains('gh-pages')) return Promise.resolve(fileContentsArray);
  console.log("Generating gh-pages");

  return Promise.all(fileContentsArray.map(function(fileContents, index) {
    return new Promise(function(resolve, reject) {
      var filename = readme2index(buildConfig.files[index], ".html");
      fs.writeFile(
        path.join(websiteDir, filename),
        wrapHTML(insertToC(fileContents, false), filename),
        vow(resolve, reject)
      );
    })
  }))
  // 3a. Copy assets over
  .then(function() {
    if(argv.contains('skipassets')) return Promise.resolve();
    console.log("Generating assets");

    return Promise.all(["logo.png", "favicon.png", "style.css"].map(function(filename) {
      var isImage = /\.(png|jpg|gif|webp)$/i.test(filename);
      return new Promise(function(resolve, reject) {
        fs.writeFile(
          path.join(websiteDir, filename),
          isImage ? unbase64(fileContents[filename]) : fileContents[filename],
          {encoding: isImage ? "base64" : "utf-8"},
          vow(resolve, reject)
        );
      });
    }));
  })
  .then(function() {
    return fileContentsArray;
  })
})
// 4. Generate ebooks
.then(function(fileContentsArray) {
  return Promise.all(Object.keys(generate).map(function(filetype) {
    if(!argv.contains(filetype)) return Promise.resolve();
    console.log("Generating " + filetype);
    return generate[filetype](fileContentsArray, path.join(ebookDir, meta.title+"."+filetype));
  }));
})
.then(function() {
  console.log("Build finished with no errors");
})
.catch(function(err) {
  console.error(err.stack || ("ERROR: "+err));
  throw err
})

//////////////////// Filetype generation ////////////////////

var generate = {
  md: function(mdArray, filename) {
    var md = insertToC(mdArray.join(mdit_plugins.pagebreak.HTML), true);
    return new Promise(function(resolve, reject) {
      fs.writeFile(filename, md, vow(resolve, reject))
    })
  },
  html: function(mdArray, filename) {
    var md = insertToC(mdArray.join(mdit_plugins.pagebreak.HTML), true);
    return new Promise(function(resolve, reject) {
      fs.writeFile(filename, wrapHTML(md), vow(resolve, reject))
    })
  },
  pdf: function(mdArray, filename) {
    var md = insertToC(mdArray.join(mdit_plugins.pagebreak.HTML), true);
    return new Promise(function(resolve, reject) {
      wkhtmltopdf(wrapHTML(md), { output: filename }, function (code, signal) {
        if(code || signal) reject(code || signal);
        else resolve();
      });
    });
  },
  epub: function(mdArray, filename) {
    var titleMd = mdArray[0].split(mdit_plugins.pagebreak.RE)[0];
    return new Promise(function(resolve, reject) {
      var mdit = mdit_plugins(markdown_it('commonmark'), tocIndex, true);

      var titleHtml = template(fileContents['title_template'], {content: mdit.render(titleMd)});

      // Remove titleMd portion from Readme.md
      mdArray[0] = mdArray[0].substr(titleMd.length).trim();
      mdArray[0] = mdArray[0].substr(mdArray[0].indexOf("\n")).trim();
      mdArray[0] = "# Preface #\n" + mdArray[0];

      // Remove the YAML '---' from the metadata on the title page
      titleMd = titleMd.replace("```\n---", "```").replace("---\n```", "```")
      try {
        require('html2png')({ width: 600, height: 776, browser: 'phantomjs'})
          .render(titleHtml, vow(resolve, reject))
      } catch(e) {
        console.log("WARNING: html2png not loaded, cover image will not be included");
        resolve();
      }
    }).then(function(coverPage) {
      return new Promise(function(resolve, reject) {
        var epub = Epub.fromMarkdown(
          meta2epub(meta),
          mdArray,
          {
            workingDir: websiteDir,
            tocInText: true,
            coverImage: coverPage,
            titlePage: titleMd
          }
        );
        epub.build(filename, vow(resolve, reject));
      }); //new Promise
    })
  }
};

//////////////////// Auxiliary functions ////////////////////

function insertToC(md, firsth1) {
  var delim = "\n##"
  var ind = md.indexOf(delim);
  if(ind === 0)
    return md;

  var toc = "## Table of Contents ##\n\n" + 
          //(tocJson ? tocJson.content : mdtoc(md, {firsth1: false}).content) + pagebreak;
          mdtoc(md, {firsth1: firsth1}).content + mdit_plugins.pagebreak.HTML;
  return md.slice(0, ind) + toc + md.slice(ind);
}


// Creates a complete HTML file (i.e. with <html>, <body>, styles, etc)
function wrapHTML(md, originalFilename) {
  var isAggregateFile = !originalFilename; //Just to be more clear

  // 1. Render the markdown
  var env = {}
  var mdit = mdit_plugins(markdown_it('commonmark'), tocIndex, isAggregateFile);
  var pagehtml = mdit.render(md, env);


  // 2. adjust options for the template
  var opts = {
    titleslug:  slugify(env.title),
    pagehref:   readme2index(originalFilename || '', ".html"),
    pagehtml:   pagehtml,
    title:      meta.title
  };
  if(isAggregateFile) {
    opts.favicon = fileContents['favicon.png'];
    opts.stylesheets = "<style>\n"+fileContents.theme+"</style>\n<style>\n"+fileContents['style.css']+"</style>\n";
    opts.stylesheets += "<style>\n" +
                          "#table-of-contents + ul > li { list-style-type: none; }\n" +
                          "#table-of-contents + ul > li > a { font-size: 1.5em; }\n" +
                          //"#table-of-contents + ul > li li > a { font-size: 1em; }\n" +
                          "#table-of-contents + ul > li li li a { font-size: 0.em; }\n" + 
                        "</style>\n";
    opts.heading = null;
  } else {
    if(env.title != meta.title)
      opts.title = env.title + " - " + meta.title;
    opts.favicon =  "favicon.png"
    opts.stylesheets = "<link rel='stylesheet' href='"+path.join("themes", themes[chosenTheme])+"'>\n" + 
        "<link rel='stylesheet' href='style.css'>\n";
    opts.heading = "\n<nav class='site-nav'>\n" + 
      "<ul>\n" + 
      "<li>\n<a>\n" + "<img src='" + opts.favicon + "'>\n<strong>"+meta.title+"</strong>\n</a>\n</li>\n" + 
      buildConfig.files.map(function(filename, i) {
        return ((false && i==Math.round(buildConfig.files.length/2)) ? "</ul><ul>" : "") +
        template("<li>\n<a href='{{href}}' class='{{class}}'>{{title}}</a>\n</li>\n", {
          href: readme2index(filename, ".html"),
          title: readme2other(filename, "about").replace(/_/g, " ").toLowerCase(),
          class: replaceExt(originalFilename) == readme2index(filename) ? "active" : ''
        });
      }).join("\n") + 
      "</ul>\n</nav>" +
      '<a class="ribbon" href="https://github.com/notbryant/slow-pc-guide"><img style="position: absolute; top: 0; right: 0; border: 0;" src="https://camo.githubusercontent.com/652c5b9acfaddf3a9c326fa6bde407b87f7be0f4/68747470733a2f2f73332e616d617a6f6e6177732e636f6d2f6769746875622f726962626f6e732f666f726b6d655f72696768745f6f72616e67655f6666373630302e706e67" alt="Fork me on GitHub" data-canonical-src="https://s3.amazonaws.com/github/ribbons/forkme_right_orange_ff7600.png"></a>'
  }

  // 3. Fill the template
  return beautify(template(fileContents.template, opts));
}

function meta2epub(meta) {
  var epubMeta = clone(meta);
  if(meta.author || meta.authors)
    epubMeta.creator = stripEmail(meta.author) || meta.authors.map(stripEmail);
  if(meta.contributors)
    epubMeta.contributor = meta.contributors.map(stripEmail);
  epubMeta.date_published = formatDate(meta.published);
  epubMeta.date_modified = formatDate(meta.modified);
  if(meta.copyright || meta.license) {
    epubMeta.rights = [];
    if(meta.copyright)
      epubMeta.rights.push("Copyright ", meta.copyright);
    if(meta.license)
      epubMeta.rights.push(meta.license);
    epubMeta.rights = epubMeta.rights.join(", ");
  }
  if(meta.version)
    epubMeta.description = "Version " + meta.version;
  ["author", "authors", "published", "modified", "copyright", "license", "version"]
    .forEach(function(x) { delete epubMeta[x]});

  epubMeta.identifier = buildConfig.uuid;
  return epubMeta;

  function stripEmail(aut) { return aut.substr(0, aut.lastIndexOf("<")).trim(); }
  function formatDate(d) {
    return  d.getFullYear() + "-" + ('0' + (d.getMonth()+1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
}