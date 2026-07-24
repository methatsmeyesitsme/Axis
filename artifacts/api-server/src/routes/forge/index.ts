import { Router, type IRouter } from "express";
import conversationsRouter from "./conversations";

const router: IRouter = Router();

router.use("/conversations", conversationsRouter);

export default router;
