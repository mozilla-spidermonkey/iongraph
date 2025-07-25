# iongraph-web devlog

## 2025-07-23

I went on a week-long vacation after the last WIP commit, so who knows what we're doing now.

A sufficiently complex ion.json still does not lay out in a reasonable way. If I recall, the problem I was facing was: how do we reliably determine what comes after a loop?

Basically, we are suffering from the same problem as graphviz, where an early exit of a loop doesn't push down below the loop in the output. We want this in order to mimic code control flow. The problem is that, from a graph layout point of view, it's not completely straightforward.

We have a similar problem of wanting to find the join point in a diamond. Right now my layout algorithm greedily goes down one path as far as it can go, then does the other -- depth first. But what I think we want is do find the *immediate post-dominator* of the branching node. This is the first node that all paths out of the branch are guaranteed to flow through. This then is the natural point at which to stop processing children, when determining tracks.

It's possible for a branching node to have no immediate post-dominator, unless we insert a dummy node at the end of the graph where all leaves go when they finish, so I think the dummy node is a good idea.

It is probably important to handle a case like:

```
┌─────────────┐
│      A      │
└──┬───┬───┬──┘
   │   │   └─────────────┐
   │   └──────┐          │
┌──┴──┐    ┌──┴──┐    ┌──┴──┐  
│  B  │    │  C  │    │  D  │  
└──┬──┘    └──┬──┘    └──┬──┘  
   │   ┌──────┘          │
┌──┴───┴──┐              │
│    E    │              │
└──┬──────┘              │
   │     ┌───────────────┘
┌──┴─────┴──┐
│     F     │
└───────────┘
```

Here, A is immediately post-dominated by F. I guess B and C are trivially post-dominated by E, but since they don't branch, maybe we don't care. Still, it's hard to decide how to assign them to tracks. I guess there should be two tracks for A's children: one for B, C, and E, and one for D. Except, that doesn't really work yet because B and C need to end up on separate tracks at *some* level.

So maybe B, C, and D all get their own tracks, but the tracks for B and C terminate at E, while D's track terminates at F...? That doesn't fit the hierarchy I was going for. It seems there should be two tracks for A (BCE and D), and then within the BCE track, there should be separate tracks for B and C.

Of course we could really screw it up like so:

```
┌─────────────┐
│      A      │
└──┬───┬───┬──┘
   │   │   └─────────────┐
   │   └──────┐          │
┌──┴──┐    ┌──┴──┐    ┌──┴──┐  
│  B  │    │  C  │    │  D  │  
└──┬──┘    └──┬──┘    └──┬──┘  
   │   ┌──────│──────────┘
┌──┴───┴──┐   │
│    E    │   │
└──┬──────┘   │
   │     ┌────┘
┌──┴─────┴──┐
│     F     │
└───────────┘
```

Now nothing works.

And then we can throw a loop in there I suppose:

```
        ┌─────┐
   ┌────┤  H  │
   │    └──┬──┘
┌──┴──┐    │
│  G  │ ┌──┴──────────┐
└──┬──┘ │      A      │
   │    └──┬───┬───┬──┘
   │       │   │   └─────────────┐
   │       │   └──────┐          │
   │    ┌──┴──┐    ┌──┴──┐    ┌──┴──┐  
   └────┤  B  │    │  C  │    │  D  │  
        └──┬──┘    └──┬──┘    └──┬──┘  
           │   ┌──────│──────────┘
        ┌──┴───┴──┐   │
        │    E    │   │
        └──┬──────┘   │
           │     ┌────┘
        ┌──┴─────┴──┐
        │     F     │
        └───────────┘
```

Or:

```
        ┌─────┐
   ┌────┤  H  │
   │    └──┬──┘
┌──┴──┐    │
│  G  │ ┌──┴──────────┐
└──┬──┘ │      A      │
   │    └──┬───┬───┬──┘
   │       │   │   └─────────────┐
   │       │   └──────┐          │
   │    ┌──┴──┐    ┌──┴──┐    ┌──┴──┐  
   │    │  B  │    │  C  │    │  D  │  
   │    └──┬──┘    └──┬──┘    └──┬──┘  
   │       │   ┌──────│──────────┘
   │    ┌──┴───┴──┐   │
   └────┤    E    │   │
        └──┬──────┘   │
           │     ┌────┘
        ┌──┴─────┴──┐
        │     F     │
        └───────────┘
```

Now we really have a conundrum because we have nodes that are, arguably, outside the loop - except that their loop depth might declare them to be inside the loop.

As we iterate, it is definitely true that any node with a smaller loop depth must be outside the loop (coming after). It also should only be possible to increase loop depth in wasm by walking directly to a loop header (thanks to the structured control flow).

It seems like the entirety of a loop should be a pretty well-formed concept, then. It would be possible to identify exactly which blocks constitute a loop: the header, the backedge, and all reachable nodes with equal or greater loop depth. (The latter condition I am not 100% confident in.)

Another way we could possibly do this is to walk backward from the backedge until we reach the loop header. It should be impossible, as far as I know, to jump forward into the middle of a loop in wasm. That said -- in the last example, C would not be reachable via this tactic, despite being in the loop according to loop depth, so this strategy seems incorrect.

On the other hand, a depth-first traversal starting from H would encounter A, B, E, G, C, D, E, and G, resulting in H, A, B, C, D, E, and G being part of the loop -- which is correct. A sub-loop (according to loop depth) would be completely contained in the outer loop (again thanks to well-formedness of both JS and WASM control flow) (I hope).

This would seem to imply that we can always chuck the entire loop in a track of its own.

(I'm not sure how OSR entry points might fit into this. What can they point at?)

Let's consider these cases, with things pushed down according to loop depth:

```
        ┌─────┐                                     ┌─────┐
   ┌────┤  H  │                                ┌────┤  H  │                      
   │    └──┬──┘                                │    └──┬──┘                      
┌──┴──┐    │                                ┌──┴──┐    │                         
│  G  │ ┌──┴──────────┐                     │  G  │ ┌──┴──────────┐              
└──┬──┘ │      A      │                     └──┬──┘ │      A      │              
   │    └──┬───┬───┬──┘                        │    └──┬───┬───┬──┘              
   │       │   │   └─────────────┐             │       │   │   └─────────────┐   
   │       │   └──────┐          │             │       │   └──────┐          │   
   │    ┌──┴──┐       │          │             │    ┌──┴──┐    ┌──┴──┐       │
   └────┤  B  │       │          │             └────┤  B  │    │  C  │       │
        └──┬──┘       │          │                  └──┬──┘    └──┬──┘       │
           │       ┌──┴──┐    ┌──┴──┐                  │          │       ┌──┴──┐
           │       │  C  │    │  D  │                  │          │       │  D  │
           │       └──┬──┘    └──┬──┘                  │          │       └──┬──┘
           │   ┌──────│──────────┘                     │   ┌──────│──────────┘
        ┌──┴───┴──┐   │                             ┌──┴───┴──┐   │              
        │    E    │   │                             │    E    │   │              
        └──┬──────┘   │                             └──┬──────┘   │              
           │     ┌────┘                                │     ┌────┘              
        ┌──┴─────┴──┐                               ┌──┴─────┴──┐                
        │     F     │                               │     F     │                
        └───────────┘                               └───────────┘                
```

According to loop depth, the first loop should consist of H, A, B, and G, and the second loop should also include C.

The position of D is a real conundrum in the second case. In general it's not clear how we would lay out A's children at all.


# 2025-07-25

Ok, coming back to this after a few days, I have not had some kind of breakthrough that makes my simple "track" algorithm work.

However, from Handmade I have learned the name of the typical DAG layout algorithm everyone uses. It's called Sugiyama, and it's actually pretty simple, and I think I can just modify it to fit this purpose and avoid some of the behaviors we don't like about graphviz.

Here are a couple YouTube videos that have decent info about the parts of the process I care about:

- https://www.youtube.com/watch?v=pKs53CuAo-8
- https://www.youtube.com/watch?v=9B3ZXsRbiCw

So basically I think we can just do a modified Sugiyama like so:

1. SKIP cycle-breaking. We can just ignore backedge nodes while assigning layers, and wedge them into the layout later somehow.
2. Assign nodes into layers with modifications for loop depth. That is, nodes outside a loop should always be placed in a layer after the final loop layer.
3. Create dummy vertices for edges that cross multiple layers. This will be helpful for routing long edges around the left or right (or maybe straight down, I dunno).
4. SKIP crossing minimization. We don't want to rearrange blocks horizontally just so that crossings are minimized; we want to preserve layout stability and predictability instead. Also, we shouldn't have that many crossings because of how these graphs are constructed from code.
5. Perform simple iterative vertex positioning to straighten edges, but try to be conservative to improve layout stability. This is also where we position dummy vertices to route long edges more elegantly.
6. Draw edges with nice straight lines instead of Bezier ugliness.

Conveniently this seems to avoid the most computationally complex parts of the problem.
